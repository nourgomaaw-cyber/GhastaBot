require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const googleClient = new OAuth2Client();
const settingsPath = path.join(__dirname, "data", "settings.json");
const usersPath = path.join(__dirname, "data", "users.json");
const sessionCookieName = "ghasta_session";
const allowedModels = new Set([
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.8-flash"
]);
const defaultSettings = {
    siteName: "Ghasta AI",
    ownerName: "Nour | نور",
    discordInvite: "https://discord.gg/hy9vGGrDX",
    serverHost: "GhastaMc.orc.host",
    serverPort: 25565,
    plugins: [
        "EssentialsX — homes, warps, and teleport commands",
        "LuckPerms — permissions and groups",
        "CoreProtect — block activity logs and rollbacks",
        "GriefPrevention — player land claims"
    ],
    customInstructions: "Answer questions accurately and clearly. Reply in the user's language, including Egyptian Arabic when appropriate. Keep replies concise unless the user asks for details.",
    model: "gemini-3.5-flash-lite",
    thinkingLevel: "minimal",
    maxOutputTokens: 512
};

function loadSettings() {
    try {
        const stored = JSON.parse(require("fs").readFileSync(settingsPath, "utf8"));
        return { ...defaultSettings, ...stored };
    } catch {
        return { ...defaultSettings };
    }
}

function saveGoogleAccount(payload) {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(usersPath), { recursive: true });
    let users = [];
    try { users = JSON.parse(fs.readFileSync(usersPath, "utf8")); } catch { users = []; }
    const now = new Date().toISOString();
    const index = users.findIndex(user => user.sub === payload.sub);
    const previous = index >= 0 ? users[index] : null;
    const account = {
        sub: payload.sub,
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email,
        picture: payload.picture || "",
        createdAt: previous?.createdAt || now,
        lastLoginAt: now
    };
    if (index >= 0) users[index] = account;
    else users.push(account);
    const tempPath = `${usersPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, usersPath);
    return account;
}

function buildSystemInstruction(settings) {
    const plugins = settings.plugins.map(line => line.trim()).filter(Boolean);
    return [
        `You are ${settings.siteName}, a helpful assistant for Ghasta MC.`,
        settings.customInstructions,
        `The owner is ${settings.ownerName}.`,
        `The Ghasta SMP Minecraft server address is ${settings.serverHost} with port ${settings.serverPort}. If asked how to join, give both.`,
        `The Ghasta AI/MC Discord invite is ${settings.discordInvite}. Share it when asked.`,
        `For plugin questions, treat them as questions about Ghasta SMP. Use only this curated list, one plugin per line: ${plugins.join("; ")}. Do not invent plugins or claim they are installed; call them the selected/recommended list.`,
        "Never claim you know something if you are unsure."
    ].filter(Boolean).join(" ");
}

function signSession(user) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error("SESSION_SECRET is not configured.");
    const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function readSession(req) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return null;
    const cookie = (req.headers.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${sessionCookieName}=`));
    if (!cookie) return null;
    const value = decodeURIComponent(cookie.slice(sessionCookieName.length + 1));
    const [payload, signature] = value.split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest();
    let actual;
    try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    try {
        const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!user.sub || !user.email || user.exp < Date.now()) return null;
        return user;
    } catch { return null; }
}

function setSessionCookie(res, token) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function requireUser(req, res, next) {
    req.user = readSession(req);
    if (!req.user) return res.status(401).json({ error: "Please sign in with Google first." });
    next();
}

function requireAdmin(req, res, next) {
    req.user = readSession(req);
    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (!req.user) return res.status(401).json({ error: "Please sign in with Google first." });
    if (!adminEmail || req.user.email.toLowerCase() !== adminEmail) {
        return res.status(403).json({ error: "This Google account is not an administrator." });
    }
    next();
}

app.get("/api/auth/config", (req, res) => {
    res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

app.get("/api/auth/me", (req, res) => {
    const user = readSession(req);
    if (!user) return res.json({ user: null });
    res.json({
        user: {
            email: user.email,
            name: user.name,
            picture: user.picture,
            isAdmin: Boolean(process.env.ADMIN_EMAIL && user.email.toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase())
        }
    });
});

app.post("/api/auth/google", async (req, res) => {
    try {
        const { credential, nonce } = req.body || {};
        if (!process.env.GOOGLE_CLIENT_ID || !process.env.SESSION_SECRET) {
            return res.status(503).json({ error: "Google sign-in is not configured yet." });
        }
        if (typeof credential !== "string" || credential.length > 12000 || typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) {
            return res.status(400).json({ error: "Google sign-in credential is missing or invalid." });
        }
        const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        if (!payload || payload.nonce !== nonce || payload.email_verified !== true || !payload.sub || !payload.email) {
            return res.status(401).json({ error: "Google could not verify this account. Please try signing in again." });
        }
        const account = saveGoogleAccount(payload);
        const token = signSession({
            sub: account.sub,
            email: account.email,
            name: account.name,
            picture: account.picture
        });
        setSessionCookie(res, token);
        res.json({ ok: true });
    } catch (error) {
        console.error("Google sign-in error:", error.message);
        res.status(401).json({ error: "Google sign-in failed. Check the OAuth setup and try again." });
    }
});

app.post("/api/auth/logout", (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
    res.json(loadSettings());
});

app.put("/api/admin/settings", requireAdmin, (req, res) => {
    const input = req.body || {};
    const current = loadSettings();
    const siteName = String(input.siteName || "").trim();
    const ownerName = String(input.ownerName || "").trim();
    const discordInvite = String(input.discordInvite || "").trim();
    const serverHost = String(input.serverHost || "").trim();
    const serverPort = Number(input.serverPort);
    const plugins = String(input.plugins || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 40);
    const customInstructions = String(input.customInstructions || "").trim();
    const model = String(input.model || "");
    const thinkingLevel = String(input.thinkingLevel || "");
    const maxOutputTokens = Number(input.maxOutputTokens);

    if (!siteName || siteName.length > 80 || !ownerName || ownerName.length > 120 || !serverHost || serverHost.length > 253 || !Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
        return res.status(400).json({ error: "Check the site name, owner, server host, and port." });
    }
    try {
        const discordUrl = new URL(discordInvite);
        if (discordUrl.protocol !== "https:" || !["discord.gg", "discord.com"].includes(discordUrl.hostname)) throw new Error("Invalid invite URL");
    } catch {
        return res.status(400).json({ error: "Enter a valid HTTPS Discord invite URL." });
    }
    if (!allowedModels.has(model) || !["minimal", "low", "medium", "high"].includes(thinkingLevel) || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 4096 || customInstructions.length > 8000 || plugins.some(line => line.length > 250)) {
        return res.status(400).json({ error: "Check the model, response settings, instructions, and plugin list." });
    }

    const updated = { siteName, ownerName, discordInvite, serverHost, serverPort, plugins, customInstructions, model, thinkingLevel, maxOutputTokens };
    try {
        require("fs").mkdirSync(path.dirname(settingsPath), { recursive: true });
        const tempPath = `${settingsPath}.tmp`;
        require("fs").writeFileSync(tempPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
        require("fs").renameSync(tempPath, settingsPath);
        res.json({ ok: true, settings: updated });
    } catch (error) {
        console.error("Settings save error:", error.message);
        res.status(500).json({ error: "Could not save admin settings." });
    }
});

app.post("/api/chat", async (req, res) => {
    try {
        const message = req.body.message;

        if (typeof message !== "string" || !message.trim()) {
            return res.status(400).json({
                error: "Please enter a question."
            });
        }

        if (message.length > 4000) {
            return res.status(400).json({
                error: "Question is too long."
            });
        }

        const settings = loadSettings();
        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({
                error: "Gemini API key is not configured."
            });
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:streamGenerateContent?alt=sse`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": process.env.GEMINI_API_KEY
                },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{ text: buildSystemInstruction(settings) }]
                    },
                    contents: [{
                        role: "user",
                        parts: [{ text: message.trim() }]
                    }],
                    generationConfig: {
                        thinkingConfig: {
                            thinkingLevel: settings.thinkingLevel
                        },
                        maxOutputTokens: settings.maxOutputTokens
                    }
                })
            }
        );

        if (!response.ok) {
            const data = await response.json();
            console.error("Gemini API error:", data);
            const apiError = data.error || {};
            const detail = `${apiError.status || ""} ${apiError.message || ""}`;

            if (response.status === 429 && detail.includes("generate_content_free_tier_requests")) {
                return res.status(429).json({
                    error: "GEMINI's free-tier daily request limit has been reached. Try again after the quota resets, or check your usage and billing in Google AI Studio."
                });
            }

            if (response.status === 429) {
                return res.status(429).json({
                    error: "GEMINI request limit reached. Wait a little and try again, or check your project limits in Google AI Studio."
                });
            }

            if (response.status === 401 || response.status === 403) {
                return res.status(502).json({
                    error: "GEMINI rejected the API key. Check that the key is valid and Gemini API access is enabled."
                });
            }

            if (response.status === 503) {
                return res.status(503).json({
                    error: "GEMINI is busy right now. Please try again in a little while."
                });
            }

            return res.status(502).json({
                error: "GEMINI could not complete the request. Please try again later."
            });
        }

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const forwardEvent = event => {
            const payload = event.split(/\r?\n/)
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trim())
                .join("\n");
            if (!payload || payload === "[DONE]") return;

            let chunk;
            try {
                chunk = JSON.parse(payload);
            } catch {
                return;
            }

            const text = (chunk.candidates?.[0]?.content?.parts || [])
                .map(part => part.text || "")
                .join("");
            if (text && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ text })}\n\n`);
            }
        };

        try {
            while (true) {
                const { value, done } = await reader.read();
                buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
                const events = buffer.split(/\r?\n\r?\n/);
                buffer = events.pop() || "";
                for (const event of events) forwardEvent(event);
                if (done) break;
            }
            if (buffer.trim()) forwardEvent(buffer);
            if (!res.writableEnded) {
                res.write("data: [DONE]\n\n");
                res.end();
            }
        } catch (error) {
            console.error("Gemini stream error:", error.message);
            if (!res.writableEnded) {
                res.write(`event: error\ndata: ${JSON.stringify({ error: "The response stream ended unexpectedly." })}\n\n`);
                res.end();
            }
        }

    } catch (error) {
        console.error("Chat error:", error.message);
        res.status(500).json({
            error: "Could not contact the AI service."
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Ghasta AI running at http://127.0.0.1:${PORT}`);
});
