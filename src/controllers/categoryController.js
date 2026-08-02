import { Category, slugify } from "../models/category.model.js";
import { Product } from "../models/product.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, created } from "../utils/ApiResponse.js";
import { badRequest, notFound } from "../utils/ApiError.js";
import { requireFields, isValidObjectId } from "../utils/validators.js";

/**
 * Resolves a :idOrSlug URL param — the storefront links by slug, the admin
 * panel by id, and both hit the same endpoints.
 */
const findCategory = async (idOrSlug) => {
    const query = isValidObjectId(idOrSlug)
        ? { _id: idOrSlug }
        : { slug: String(idOrSlug).toLowerCase() };
    return Category.findOne(query);
};

/**
 * @route GET /api/categories
 * Query: ?tree=true (nested) | ?parent=<id|null> | ?includeInactive=true
 */
export const listCategories = asyncHandler(async (req, res) => {
    const { tree, parent, includeInactive } = req.query;

    const filter = {};
    if (includeInactive !== "true") filter.isActive = true;

    if (tree === "true") {
        const roots = await Category.find({ ...filter, parent: null })
            .sort({ sortOrder: 1, name: 1 })
            .populate({
                path: "children",
                match: includeInactive === "true" ? {} : { isActive: true },
                options: { sort: { sortOrder: 1, name: 1 } },
            })
            .lean({ virtuals: true });

        return ok(res, { categories: roots }, "Category tree fetched.");
    }

    if (parent !== undefined) {
        filter.parent = parent === "null" || parent === "" ? null : parent;
    }

    const categories = await Category.find(filter)
        .sort({ sortOrder: 1, name: 1 })
        .lean();

    return ok(res, { categories, count: categories.length }, "Categories fetched.");
});

/**
 * @route GET /api/categories/:idOrSlug
 * Includes a live product count so the storefront can show "24 products".
 */
export const getCategory = asyncHandler(async (req, res) => {
    const category = await findCategory(req.params.idOrSlug);
    if (!category) throw notFound("Category not found.");

    const [children, productCount] = await Promise.all([
        Category.find({ parent: category._id, isActive: true })
            .sort({ sortOrder: 1, name: 1 })
            .lean(),
        Product.countDocuments({ category: category._id, isActive: true }),
    ]);

    return ok(res, { category, children, productCount }, "Category fetched.");
});

/**
 * @route GET /api/categories/:idOrSlug/products
 * Convenience wrapper — the same filters as /api/products but scoped to
 * this category (and its direct children).
 */
export const getCategoryProducts = asyncHandler(async (req, res) => {
    const category = await findCategory(req.params.idOrSlug);
    if (!category) throw notFound("Category not found.");

    const children = await Category.find({ parent: category._id }).select("_id").lean();
    const categoryIds = [category._id, ...children.map((c) => c._id)];

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [products, total] = await Promise.all([
        Product.find({ category: { $in: categoryIds }, isActive: true })
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate("category", "name slug")
            .lean({ virtuals: true }),
        Product.countDocuments({ category: { $in: categoryIds }, isActive: true }),
    ]);

    return ok(
        res,
        {
            category: { _id: category._id, name: category.name, slug: category.slug },
            products,
            meta: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1,
            },
        },
        "Category products fetched.",
    );
});

/** @route POST /api/categories — admin only. */
export const createCategory = asyncHandler(async (req, res) => {
    const { name, description, image, parent, sortOrder } = req.body;
    requireFields(req.body, ["name"]);

    if (parent && !isValidObjectId(parent)) throw badRequest("Invalid parent category id.");
    if (parent && !(await Category.exists({ _id: parent }))) {
        throw badRequest("Parent category does not exist.");
    }

    const slug = slugify(name);
    if (await Category.exists({ slug })) {
        throw badRequest(`A category with the slug "${slug}" already exists.`);
    }

    const category = await Category.create({
        name: name.trim(),
        slug,
        description,
        image,
        parent: parent || null,
        sortOrder: sortOrder ?? 0,
    });

    return created(res, { category }, "Category created.");
});

/** @route PATCH /api/categories/:id — admin only. */
export const updateCategory = asyncHandler(async (req, res) => {
    const { name, description, image, parent, sortOrder, isActive } = req.body;

    const category = await Category.findById(req.params.id);
    if (!category) throw notFound("Category not found.");

    if (parent !== undefined) {
        if (parent && String(parent) === String(category._id)) {
            throw badRequest("A category cannot be its own parent.");
        }
        category.parent = parent || null;
    }

    if (name !== undefined) {
        category.name = name.trim();
        const newSlug = slugify(name);
        if (newSlug !== category.slug && (await Category.exists({ slug: newSlug }))) {
            throw badRequest(`A category with the slug "${newSlug}" already exists.`);
        }
        category.slug = newSlug;
    }
    if (description !== undefined) category.description = description;
    if (image !== undefined) category.image = image;
    if (sortOrder !== undefined) category.sortOrder = sortOrder;
    if (isActive !== undefined) category.isActive = isActive;

    await category.save();
    return ok(res, { category }, "Category updated.");
});

/**
 * @route DELETE /api/categories/:id — admin only.
 * Refuses to delete while products or subcategories still point at it, so
 * the catalog can never end up with orphaned references.
 */
export const deleteCategory = asyncHandler(async (req, res) => {
    const category = await Category.findById(req.params.id);
    if (!category) throw notFound("Category not found.");

    const [productCount, childCount] = await Promise.all([
        Product.countDocuments({ category: category._id }),
        Category.countDocuments({ parent: category._id }),
    ]);

    if (productCount > 0) {
        throw badRequest(
            `Cannot delete: ${productCount} product(s) still belong to this category. Deactivate it instead.`,
        );
    }
    if (childCount > 0) {
        throw badRequest(`Cannot delete: this category has ${childCount} subcategory(ies).`);
    }

    await category.deleteOne();
    return ok(res, null, "Category deleted.");
});
