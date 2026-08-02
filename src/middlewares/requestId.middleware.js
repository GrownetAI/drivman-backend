import { randomUUID } from "crypto";

// Header values are echoed back to the client, so anything that isn't a plain
// token gets discarded rather than reflected.
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Stamps every request with an id so one request can be followed across log
 * lines — which is what makes an email delivery traceable end to end.
 * An inbound X-Request-Id from a proxy or gateway is honoured so the id spans
 * services; anything malformed is replaced with a fresh UUID.
 */
export const requestId = (req, res, next) => {
    const inbound = req.headers["x-request-id"];
    req.id = typeof inbound === "string" && SAFE_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader("X-Request-Id", req.id);
    next();
};
