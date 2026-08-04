/**
 * TEMPORARY — remove once real email provider is configured.
 *
 * Dev-only adapter used when EMAIL_PROVIDER=console. Instead of calling
 * Resend or SMTP, it prints the email to the server console so local/dev
 * work (signup OTP, password reset, etc.) isn't blocked on a real
 * RESEND_API_KEY or SMTP credentials. No message is actually delivered.
 */
export const consoleProvider = {
    name: "console",

    async send({ from, to, subject, html, text, replyTo }) {
        console.log("\n===== [console email provider] EMAIL NOT SENT (dev mode) =====");
        console.log(`From:    ${from}`);
        console.log(`To:      ${to}`);
        if (replyTo) console.log(`ReplyTo: ${replyTo}`);
        console.log(`Subject: ${subject}`);
        console.log(`Text:\n${text ?? ""}`);
        if (html) console.log(`HTML:\n${html}`);
        console.log("================================================================\n");
        return { id: null };
    },
};
