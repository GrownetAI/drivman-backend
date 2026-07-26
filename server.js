import express from "express";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import userRoutes from "./src/routes/user.routes.js";
 
dotenv.config();
 
const app = express();
 
app.use(express.json());
app.use(cookieParser());
 
app.use("/api/users", userRoutes);
 
mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection error:", err));
 
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));