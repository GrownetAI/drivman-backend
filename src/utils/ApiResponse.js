/**
 * Single response shape for the whole API so the frontend never has to
 * guess: { success, message, data }.
 */
export const ok = (res, data = null, message = "OK", statusCode = 200) =>
    res.status(statusCode).json({ success: true, message, data });

export const created = (res, data = null, message = "Created") =>
    ok(res, data, message, 201);
