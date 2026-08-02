/**
 * Transactional email templates — plain HTML strings, matching what the project
 * already used. Every interpolated value is escaped: a full name or product
 * title is user-controlled, and unescaped it would let a signup inject markup
 * into an email we send under our own domain.
 */
const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const layout = (heading, bodyHtml) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#1a1a1a">
  <h1 style="margin:0 0 8px;font-size:22px;font-weight:600">DRIVMAN</h1>
  <h2 style="margin:0 0 20px;font-size:17px;font-weight:600;color:#444">${heading}</h2>
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0" />
  <p style="font-size:12px;color:#888;margin:0">
    If you didn't request this, you can safely ignore this email.
  </p>
</div>`;

const button = (url, label) => `
  <p style="margin:0 0 20px">
    <a href="${escapeHtml(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:14px">${escapeHtml(label)}</a>
  </p>
  <p style="font-size:13px;color:#666;margin:0 0 4px">Or paste this link into your browser:</p>
  <p style="font-size:12px;color:#666;word-break:break-all;margin:0">${escapeHtml(url)}</p>`;

const linkBase = (baseUrl) => String(baseUrl || "http://localhost:3000").replace(/\/$/, "");

/**
 * The signup verification code. The code is kept out of the subject line so it
 * doesn't sit in a lock-screen notification preview.
 */
export const otpEmail = ({ fullName, code, ttlMinutes }) => ({
    subject: "Your DRIVMAN verification code",
    text: `Hi ${fullName || "there"}, your DRIVMAN verification code is ${code}. It expires in ${ttlMinutes} minutes. Don't share it with anyone.`,
    html: layout(
        "Verify your email address",
        `<p style="font-size:14px;line-height:1.6;margin:0 0 20px">
         Hi ${escapeHtml(fullName || "there")}, use this code to confirm your email address.
       </p>
       <p style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f4f4f5;border-radius:8px;padding:18px 12px;margin:0 0 20px">${escapeHtml(code)}</p>
       <p style="font-size:13px;color:#666;line-height:1.6;margin:0">
         This code expires in <strong>${escapeHtml(ttlMinutes)} minutes</strong>. Never share it with anyone — DRIVMAN staff will never ask you for it.
       </p>`,
    ),
});

export const verificationEmail = ({ fullName, token, ttlMinutes, baseUrl }) => {
    const url = `${linkBase(baseUrl)}/verify-email?token=${encodeURIComponent(token)}`;
    return {
        subject: "Verify your DRIVMAN email address",
        text: `Hi ${fullName}, verify your email: ${url} (expires in ${ttlMinutes} minutes)`,
        html: layout(
            "Confirm your email address",
            `<p style="font-size:14px;line-height:1.6;margin:0 0 20px">
         Hi ${escapeHtml(fullName)}, thanks for signing up. Confirm your email address to activate your account.
         This link expires in <strong>${escapeHtml(ttlMinutes)} minutes</strong>.
       </p>${button(url, "Verify email")}`,
        ),
    };
};

export const passwordResetEmail = ({ fullName, token, ttlMinutes, baseUrl }) => {
    const url = `${linkBase(baseUrl)}/reset-password?token=${encodeURIComponent(token)}`;
    return {
        subject: "Reset your DRIVMAN password",
        text: `Hi ${fullName}, reset your password: ${url} (expires in ${ttlMinutes} minutes)`,
        html: layout(
            "Reset your password",
            `<p style="font-size:14px;line-height:1.6;margin:0 0 20px">
         Hi ${escapeHtml(fullName)}, we received a request to reset your password.
         This link expires in <strong>${escapeHtml(ttlMinutes)} minutes</strong>.
       </p>${button(url, "Reset password")}`,
        ),
    };
};

export const orderConfirmationEmail = ({ fullName, order }) => {
    const rows = order.items
        .map(
            (item) => `<tr>
        <td style="padding:8px 0;font-size:14px">${escapeHtml(item.name)} &times; ${escapeHtml(item.quantity)}</td>
        <td style="padding:8px 0;font-size:14px;text-align:right">₹${escapeHtml(item.subtotal.toFixed(2))}</td>
      </tr>`,
        )
        .join("");

    return {
        subject: `Order ${order.orderNumber} confirmed`,
        text: `Your order ${order.orderNumber} totalling ₹${order.grandTotal.toFixed(2)} is confirmed.`,
        html: layout(
            `Order ${escapeHtml(order.orderNumber)} confirmed`,
            `<p style="font-size:14px;line-height:1.6;margin:0 0 16px">
         Hi ${escapeHtml(fullName)}, thanks for your order. Here's what you bought:
       </p>
       <table style="width:100%;border-collapse:collapse">${rows}
         <tr><td colspan="2" style="border-top:1px solid #e5e5e5;padding-top:8px"></td></tr>
         <tr>
           <td style="font-size:15px;font-weight:600">Total</td>
           <td style="font-size:15px;font-weight:600;text-align:right">₹${escapeHtml(order.grandTotal.toFixed(2))}</td>
         </tr>
       </table>`,
        ),
    };
};
