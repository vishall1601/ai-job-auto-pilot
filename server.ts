import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import axios from "axios";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { google } from "googleapis";

dotenv.config();

const db = new Database("job_autopilot_v2.db");

// Initialize Database with multi-user support
db.exec(`
  CREATE TABLE IF NOT EXISTS profile (
    linkedin_id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    phone TEXT,
    skills TEXT,
    experience TEXT,
    resume_text TEXT,
    target_roles TEXT,
    location TEXT,
    linkedin_token TEXT,
    google_token TEXT,
    google_refresh_token TEXT,
    google_sheet_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Add columns if they don't exist (for existing databases)
try { db.exec("ALTER TABLE profile ADD COLUMN google_token TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE profile ADD COLUMN google_refresh_token TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE profile ADD COLUMN google_sheet_id TEXT"); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    title TEXT,
    company TEXT,
    location TEXT,
    source TEXT,
    url TEXT UNIQUE,
    description TEXT,
    status TEXT DEFAULT 'found', -- found, analyzing, prepared, applied, rejected
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES profile(linkedin_id)
  );

  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    job_id INTEGER,
    cover_letter TEXT,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES profile(linkedin_id),
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(cookieParser());

  // Middleware to get current user from cookie
  const getCurrentUser = (req: express.Request) => req.cookies.user_id;

  const getGoogleAuth = (redirectUri: string) => {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );
  };

  const appendToSheet = async (userId: string, job: any) => {
    const profile = db.prepare("SELECT * FROM profile WHERE linkedin_id = ?").get(userId) as any;
    if (!profile || !profile.google_token || !profile.google_sheet_id) {
      console.log(`Skipping sheet append for ${userId}: Missing token or sheet ID`);
      return;
    }

    // Use a consistent redirect URI even for non-auth calls
    const baseUrl = (process.env.APP_URL || "").replace(/\/$/, "");
    const redirectUri = `${baseUrl}/auth/google/callback`;
    const auth = getGoogleAuth(redirectUri); 
    
    auth.setCredentials({
      access_token: profile.google_token,
      refresh_token: profile.google_refresh_token
    });

    // Listen for refreshed tokens and save them
    auth.on('tokens', (tokens) => {
      if (tokens.access_token) {
        console.log(`Refreshed access token for user ${userId}`);
        db.prepare("UPDATE profile SET google_token = ? WHERE linkedin_id = ?")
          .run(tokens.access_token, userId);
      }
    });

    const sheets = google.sheets({ version: 'v4', auth });
    try {
      // First, check if the sheet exists. If not, we might need to use a different range or create it.
      // For simplicity, we'll try to append to 'A:E' which defaults to the first sheet if 'Sheet1' is missing.
      await sheets.spreadsheets.values.append({
        spreadsheetId: profile.google_sheet_id,
        range: 'A:E', // Removed 'Sheet1!' to be more flexible
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            new Date().toLocaleDateString(),
            job.title,
            job.company,
            job.location,
            job.url
          ]]
        }
      });
      console.log(`Successfully appended job to sheet for user ${userId}`);
    } catch (error: any) {
      console.error(`Error appending to sheet for user ${userId}:`, error.message);
      if (error.message.includes('invalid_grant')) {
        console.log(`Token invalid for user ${userId}. User needs to re-connect Google.`);
      }
    }
  };

  // API Routes
  app.get("/api/profile", (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) return res.json({});
    const profile = db.prepare("SELECT * FROM profile WHERE linkedin_id = ?").get(userId);
    res.json(profile || {});
  });

  app.post("/api/profile", (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) {
      console.log("Profile update failed: No user_id cookie found.");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { name, email, phone, skills, experience, resume_text, target_roles, location } = req.body;
    console.log(`Updating profile for user: ${userId}`);
    
    try {
      const result = db.prepare(`
        UPDATE profile SET 
          name = ?, email = ?, phone = ?, skills = ?, experience = ?, 
          resume_text = ?, target_roles = ?, location = ?
        WHERE linkedin_id = ?
      `).run(name, email, phone, skills, experience, resume_text, target_roles, location, userId);
      
      if (result.changes === 0) {
        console.log(`No profile found to update for user: ${userId}. Attempting insert.`);
        // If update failed, maybe the record was deleted? Let's insert it.
        db.prepare(`
          INSERT INTO profile (linkedin_id, name, email, phone, skills, experience, resume_text, target_roles, location)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, name, email, phone, skills, experience, resume_text, target_roles, location);
      }
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("Profile update error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/profile/sheet", async (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { sheet_url } = req.body;
    // Extract ID from URL: https://docs.google.com/spreadsheets/d/ID/edit...
    const match = sheet_url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    const sheetId = match ? match[1] : sheet_url.trim();

    db.prepare("UPDATE profile SET google_sheet_id = ? WHERE linkedin_id = ?").run(sheetId, userId);
    
    // Sync existing jobs to the sheet immediately
    const jobs = db.prepare("SELECT * FROM jobs WHERE user_id = ?").all(userId) as any[];
    if (jobs.length > 0) {
      console.log(`Syncing ${jobs.length} existing jobs to sheet for user ${userId}`);
      // We do this in the background to not block the response
      (async () => {
        for (const job of jobs) {
          await appendToSheet(userId, job);
          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      })();
    }

    res.json({ success: true, sheetId });
  });

  app.post("/api/profile/delete", (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    db.prepare("DELETE FROM applications WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM jobs WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM profile WHERE linkedin_id = ?").run(userId);
    
    res.clearCookie("user_id");
    res.json({ success: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("user_id");
    res.json({ success: true });
  });

  // Google OAuth Routes
  app.get("/api/auth/google/url", (req, res) => {
    const origin = req.query.origin as string || req.get("origin") || req.get("referer") || process.env.APP_URL || "";
    const baseUrl = origin.replace(/\/$/, "");
    const redirectUri = `${baseUrl}/auth/google/callback`;
    const auth = getGoogleAuth(redirectUri);
    
    // Pass the redirectUri in state to ensure consistency during the callback
    const state = Buffer.from(JSON.stringify({ redirectUri })).toString('base64');
    
    const url = auth.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/spreadsheets"],
      prompt: "consent",
      state: state
    });
    res.json({ url });
  });

  app.get("/auth/google/callback", async (req, res) => {
    const { code, state } = req.query;
    const userId = getCurrentUser(req);
    
    let redirectUri = "";
    try {
      if (state) {
        const decodedState = JSON.parse(Buffer.from(state as string, 'base64').toString());
        redirectUri = decodedState.redirectUri;
      }
    } catch (e) {
      console.error("Failed to parse Google state:", e);
    }

    // Fallback if state parsing fails
    if (!redirectUri) {
      const host = req.get("host");
      const protocol = req.protocol === "http" && host?.includes(".run.app") ? "https" : req.protocol;
      const baseUrl = `${protocol}://${host}`;
      redirectUri = `${baseUrl}/auth/google/callback`;
    }

    if (!userId) return res.status(401).send("Login with LinkedIn first");

    try {
      const auth = getGoogleAuth(redirectUri);
      const { tokens } = await auth.getToken(code as string);
      
      if (tokens.refresh_token) {
        db.prepare("UPDATE profile SET google_token = ?, google_refresh_token = ? WHERE linkedin_id = ?")
          .run(tokens.access_token, tokens.refresh_token, userId);
      } else {
        db.prepare("UPDATE profile SET google_token = ? WHERE linkedin_id = ?")
          .run(tokens.access_token, userId);
      }

      res.send(`
        <html>
          <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f5f5f5;">
            <div style="background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center;">
              <h2 style="color: #4caf50;">Google Connected!</h2>
              <p>Your job data will now sync to your Google Sheet.</p>
              <button onclick="window.close()" style="background: #141414; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: bold;">Close Window</button>
            </div>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, '*');
                setTimeout(() => window.close(), 2000);
              }
            </script>
          </body>
        </html>
      `);
    } catch (error: any) {
      res.status(500).send("Google Auth Failed: " + error.message);
    }
  });

  // LinkedIn OAuth Endpoints
  app.get("/api/auth/linkedin/url", (req, res) => {
    const origin = req.query.origin as string || req.get("origin") || req.get("referer") || process.env.APP_URL || "";
    const baseUrl = origin.replace(/\/$/, "");
    const redirectUri = `${baseUrl}/auth/linkedin/callback`;
    const clientId = (process.env.LINKEDIN_CLIENT_ID || "").trim();
    
    if (!clientId) {
      return res.status(500).json({ error: "LinkedIn Client ID not configured" });
    }

    // Pass the redirectUri in state to ensure consistency during the callback
    const state = Buffer.from(JSON.stringify({ redirectUri, nonce: Math.random().toString(36).substring(7) })).toString('base64');

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state,
      scope: "openid profile email",
    });

    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
    res.json({ url: authUrl });
  });

  app.get("/auth/linkedin/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;
    
    let redirectUri = "";
    try {
      if (state) {
        const decodedState = JSON.parse(Buffer.from(state as string, 'base64').toString());
        redirectUri = decodedState.redirectUri;
      }
    } catch (e) {
      console.error("Failed to parse state:", e);
    }

    // Fallback if state parsing fails
    if (!redirectUri) {
      const host = req.get("host");
      const protocol = req.protocol === "http" && host?.includes(".run.app") ? "https" : req.protocol;
      const baseUrl = `${protocol}://${host}`;
      redirectUri = `${baseUrl}/auth/linkedin/callback`;
    }

    if (error) {
      return res.status(400).send(`
        <div style="font-family: sans-serif; padding: 40px;">
          <h2 style="color: #d32f2f;">LinkedIn Authorization Error</h2>
          <p>LinkedIn returned an error during the login process:</p>
          <pre style="background: #f5f5f5; padding: 15px; border: 1px solid #ddd;">${error}: ${error_description}</pre>
          <button onclick="window.close()">Close Window</button>
        </div>
      `);
    }

    if (!code) {
      return res.status(400).send(`
        <div style="font-family: sans-serif; padding: 40px;">
          <h2 style="color: #d32f2f;">Missing Authorization Code</h2>
          <p>No authorization code was received from LinkedIn. This can happen if the login was interrupted or if there's a configuration mismatch.</p>
          <button onclick="window.close()">Close Window</button>
        </div>
      `);
    }

    try {
      const response = await axios.post("https://www.linkedin.com/oauth/v2/accessToken", 
        new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: redirectUri,
          client_id: (process.env.LINKEDIN_CLIENT_ID || "").trim(),
          client_secret: (process.env.LINKEDIN_CLIENT_SECRET || "").trim(),
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );

      const accessToken = response.data.access_token;
      
      // Fetch profile data using OpenID Connect endpoint
      const profileRes = await axios.get("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const { sub: linkedinId, name, email } = profileRes.data;

      // Upsert profile
      const existing = db.prepare("SELECT * FROM profile WHERE linkedin_id = ?").get(linkedinId);
      if (existing) {
        db.prepare("UPDATE profile SET linkedin_token = ?, name = ?, email = ? WHERE linkedin_id = ?")
          .run(accessToken, name, email, linkedinId);
      } else {
        db.prepare("INSERT INTO profile (linkedin_id, name, email, linkedin_token) VALUES (?, ?, ?, ?)")
          .run(linkedinId, name, email, accessToken);
      }

      // Set session cookie
      res.cookie("user_id", linkedinId, { 
        httpOnly: true, 
        secure: true, 
        sameSite: 'none',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'linkedin' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>LinkedIn connected successfully. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (error: any) {
      const errorData = error.response?.data;
      console.error("LinkedIn OAuth Error:", errorData || error.message);
      
      const errorMessage = errorData?.error_description || errorData?.message || error.message;
      const host = req.get("host");
      const protocol = req.protocol === "http" && host?.includes(".run.app") ? "https" : req.protocol;
      const baseUrl = `${protocol}://${host}`;
      const redirectUri = `${baseUrl}/auth/linkedin/callback`;

      res.status(500).send(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; line-height: 1.6; max-width: 800px; margin: 0 auto;">
            <h2 style="color: #d32f2f;">Authentication Failed</h2>
            <p>LinkedIn returned an error during the token exchange:</p>
            <pre style="background: #f5f5f5; padding: 15px; border: 1px solid #ddd; overflow-x: auto;">${errorMessage}</pre>
            
            <div style="background: #fff3e0; padding: 20px; border-left: 5px solid #ff9800; margin: 20px 0;">
              <h3 style="margin-top: 0;">Debug Information</h3>
              <p style="font-size: 14px;">Please verify these details in your LinkedIn Developer Portal:</p>
              <ul style="font-size: 13px;">
                <li><b>Redirect URI used:</b> <code style="background: #eee; padding: 2px 4px;">${redirectUri}</code></li>
                <li><b>Client ID:</b> <code style="background: #eee; padding: 2px 4px;">${(process.env.LINKEDIN_CLIENT_ID || "").trim()}</code></li>
                <li><b>Products:</b> Ensure "Sign In with LinkedIn using OpenID Connect" is enabled.</li>
              </ul>
            </div>

            <p><strong>Steps to fix:</strong></p>
            <ol>
              <li>Go to <a href="https://www.linkedin.com/developers/" target="_blank">LinkedIn Developers</a>.</li>
              <li>Check <b>Auth -> OAuth 2.0 settings</b> and make sure the Redirect URI above matches <b>EXACTLY</b>.</li>
              <li>Check <b>Products</b> and make sure "Sign In with LinkedIn using OpenID Connect" is active.</li>
              <li>Try clearing your browser cookies and try again.</li>
            </ol>
            
            <div style="margin-top: 30px; display: flex; gap: 10px;">
              <button onclick="window.location.reload()" style="padding: 10px 20px; cursor: pointer; background: #141414; color: white; border: none;">Retry Exchange</button>
              <button onclick="window.close()" style="padding: 10px 20px; cursor: pointer;">Close Window</button>
            </div>
          </body>
        </html>
      `);
    }
  });

  app.get("/api/auth/linkedin/config", (req, res) => {
    const host = req.get("host");
    const protocol = req.protocol === "http" && host?.includes(".run.app") ? "https" : req.protocol;
    const baseUrl = `${protocol}://${host}`;
    const redirectUri = `${baseUrl}/auth/linkedin/callback`;
    res.json({ 
      redirectUri,
      hasClientId: !!process.env.LINKEDIN_CLIENT_ID,
      hasClientSecret: !!process.env.LINKEDIN_CLIENT_SECRET
    });
  });

  app.get("/api/jobs", (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) return res.json([]);
    const jobs = db.prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC").all(userId);
    res.json(jobs);
  });

  app.post("/api/jobs", (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { title, company, location, source, url, description } = req.body;
    try {
      db.prepare(`
        INSERT INTO jobs (user_id, title, company, location, source, url, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(userId, title, company, location, source, url, description);
      
      // Trigger sheet append
      appendToSheet(userId, { title, company, location, url });
      
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: "Job already exists or invalid data" });
    }
  });

  app.patch("/api/jobs/:id", (req, res) => {
    const userId = getCurrentUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { status } = req.body;
    db.prepare("UPDATE jobs SET status = ? WHERE id = ? AND user_id = ?").run(status, req.params.id, userId);
    res.json({ success: true });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
