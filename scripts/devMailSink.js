import net from "net";

/**
 * A throwaway SMTP server for local development.
 *
 * It speaks just enough of the protocol to make nodemailer happy, accepts every
 * message, prints a one-line summary, and throws the mail away. Nothing leaves
 * the machine and no provider account is needed — which means the signup and
 * password-reset flows can be exercised end to end with no Resend key.
 *
 * Not a mail server. Do not point anything but local development at it:
 * it accepts any credentials and delivers nothing.
 *
 *   node scripts/devMailSink.js          # then EMAIL_PROVIDER=smtp SMTP_PORT=2525
 *   npm run dev:mail                     # runs this and the API together
 */
const PORT = Number(process.env.MAIL_SINK_PORT) || 2525;

/**
 * Decodes quoted-printable enough to read a link out of the body. Nodemailer
 * wraps encoded bodies at 76 characters with a trailing "=" (which splits long
 * reset tokens across lines) and escapes literal "=" as "=3D" — so a URL's
 * "?token=" arrives as "?token=3D". Both have to go, in that order.
 */
const unwrapQuotedPrintable = (body) =>
    body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

/**
 * Pulls the code out of the plaintext part. Covers both wordings the templates
 * use — "your DRIVMAN verification code is 418302" (signup) and "use code
 * 064300 to confirm" (email change) — so a new template can't silently stop
 * printing and leave a stale code on screen.
 *
 * This is why the sink is development-only: it prints a live credential.
 */
const extractCode = (body) =>
    /(?:code is|use code)\s+(\d{6})/i.exec(body)?.[1] ?? null;

/** Password-reset and verification links, so they can be clicked from the terminal. */
const extractLink = (body) =>
    /https?:\/\/[^\s"<>]*(?:verify-email|reset-password)\?token=[A-Za-z0-9._%-]+/i.exec(body)?.[0] ??
    null;

// Codes the client may send before the message body. Anything not listed gets a
// generic 250, which is enough for the handful of verbs nodemailer uses.
const respond = (socket, line, state) => {
    const verb = line.slice(0, 4).toUpperCase();

    if (state.readingBody) {
        if (line === ".") {
            state.readingBody = false;
            const subject = /^subject:\s*(.+)$/im.exec(state.body)?.[1] ?? "(no subject)";
            const decoded = unwrapQuotedPrintable(state.body);
            const code = extractCode(decoded);
            const link = extractLink(decoded);

            console.log(`  ↳ to: ${state.recipients.join(", ") || "(none)"}`);
            console.log(`  ↳ subject: ${subject.trim()}`);
            if (code) console.log(`  ↳ CODE: ${code}`);
            if (link) console.log(`  ↳ link: ${link}`);
            console.log(`  ↳ ${Buffer.byteLength(state.body)} bytes discarded\n`);

            state.body = "";
            state.recipients = [];
            socket.write("250 2.0.0 Ok: queued as SINK\r\n");
            return;
        }
        // RFC 5321 dot-stuffing: a leading ".." in the body means a literal ".".
        state.body += (line.startsWith("..") ? line.slice(1) : line) + "\n";
        return;
    }

    switch (verb) {
        case "EHLO":
            // Advertise AUTH so nodemailer will send credentials rather than erroring.
            socket.write("250-drivman-dev-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
            return;
        case "HELO":
            socket.write("250 drivman-dev-sink\r\n");
            return;
        case "AUTH":
            socket.write("235 2.7.0 Authentication successful\r\n");
            return;
        case "MAIL":
            socket.write("250 2.1.0 Ok\r\n");
            return;
        case "RCPT": {
            const address = /<([^>]+)>/.exec(line)?.[1];
            if (address) state.recipients.push(address);
            socket.write("250 2.1.5 Ok\r\n");
            return;
        }
        case "DATA":
            state.readingBody = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
            return;
        case "RSET":
            state.body = "";
            state.recipients = [];
            state.readingBody = false;
            socket.write("250 2.0.0 Ok\r\n");
            return;
        case "QUIT":
            socket.write("221 2.0.0 Bye\r\n");
            socket.end();
            return;
        default:
            socket.write("250 2.0.0 Ok\r\n");
    }
};

const server = net.createServer((socket) => {
    const state = { buffer: "", body: "", recipients: [], readingBody: false };

    socket.setEncoding("utf8");
    socket.write("220 drivman-dev-sink ESMTP ready\r\n");

    socket.on("data", (chunk) => {
        state.buffer += chunk;
        const lines = state.buffer.split("\r\n");
        // The trailing element is an incomplete line; keep it for the next chunk.
        state.buffer = lines.pop() ?? "";
        for (const line of lines) respond(socket, line, state);
    });

    // A client hanging up mid-conversation is normal here, not an error.
    socket.on("error", () => {});
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(
            `Port ${PORT} is already in use — a sink may already be running.\n` +
                `Set MAIL_SINK_PORT to use a different port.`,
        );
        process.exit(1);
    }
    throw error;
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`Dev mail sink listening on 127.0.0.1:${PORT}`);
    console.log("Every message is accepted, summarised here, and discarded.\n");
});

const shutdown = () => {
    server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
