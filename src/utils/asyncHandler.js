/**
 * Wraps an async route handler so a rejected promise reaches Express's
 * error middleware instead of hanging the request. Every controller in
 * this codebase is wrapped in this — that's why none of them carry
 * their own try/catch.
 */
export const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};
