// ═══════════════════════════════════════════════════════════
//  AI Mock Interview — Express Backend Server
//  Handles: Groq API, Sarvam TTS/STT, Interview Analysis
// ═══════════════════════════════════════════════════════════

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const multer = require("multer");
const fs = require("fs");
const mongoose = require("mongoose");
const { exec, spawn } = require("child_process");
const path = require("path");
const dns = require("dns");
const cron = require("node-cron");

require("dotenv").config();

// Ranking models & utilities
const ResumeRanking = require("./models/ResumeRanking");
const InterviewRanking = require("./models/InterviewRanking");
const classifyJobCategory = require("./utils/classifyJobCategory");
const normalizeScore = require("./utils/normalizeScore");
const leaderboardRouter = require("./routes/leaderboard");
const plansRouter = require("./routes/plans");
const paymentRouter = require("./routes/payment");
const PLAN_LIMITS = require("./config/planLimits");
const checkUsageLimit = require("./middleware/checkUsageLimit");

// Force Google DNS for SRV lookups (Node.js c-ares has issues on some networks)
dns.setServers(["8.8.8.8", "8.8.4.4"]);

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/career-platform";
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 10000,
})
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// ── Enhanced Job Schema ──────────────────────────────────────
const jobSchema = new mongoose.Schema({
  title:           { type: String, default: "" },
  company:         { type: String, default: "" },
  location:        { type: String, default: "" },
  city:            { type: String, default: "" },
  state:           { type: String, default: "" },
  country:         { type: String, default: "" },
  description:     { type: String, default: "" },
  url:             { type: String, default: "" },
  salary:          { type: String, default: "" },
  skills:          { type: [String], default: [] },
  jobType:         { type: String, default: "" },
  isRemote:        { type: Boolean, default: false },
  datePosted:      { type: String, default: "" },
  source:          { type: String, default: "" },
  experienceLevel: { type: String, default: "mid" },
  fetchedAt:       { type: Date, default: Date.now },
  uniqueId:        { type: String, unique: true },
});
jobSchema.index({ fetchedAt: -1 });
jobSchema.index({ datePosted: -1 });
jobSchema.index({ source: 1 });
jobSchema.index({ country: 1 });
jobSchema.index({ experienceLevel: 1 });
const Job = mongoose.model("Job", jobSchema);

// ── Profile Schema ────────────────────────────────────────────
const resumeSubSchema = new mongoose.Schema({
  title:                  { type: String, default: "" },
  content:                { type: String, default: "" },
  cloudinaryUrl:          { type: String, default: "" },
  cloudinaryPublicId:     { type: String, default: "" },
  createdAt:              { type: Date, default: Date.now },
  updatedAt:              { type: Date, default: Date.now },
}, { _id: true });

const profileSchema = new mongoose.Schema({
  clerkId:    { type: String, unique: true, required: true },
  email:      { type: String, default: "" },
  username:   { type: String, default: "" },
  firstName:  { type: String, default: "" },
  lastName:   { type: String, default: "" },
  role:       { type: String, enum: ["user", "admin"], default: "user" },
  plan:       { type: String, enum: ["free", "pro", "max"], default: "free" },
  hasChosenPlan: { type: Boolean, default: false },
  planSelectedAt: { type: Date, default: null },
  usageCounters: {
    resumeAnalysis: {
      count: { type: Number, default: 0 },
      lastReset: { type: Date, default: Date.now },
    },
    jobFitResume: {
      count: { type: Number, default: 0 },
      lastReset: { type: Date, default: Date.now },
    },
    interviewPrep: {
      count: { type: Number, default: 0 },
      lastReset: { type: Date, default: Date.now },
    },
    coverLetter: {
      count: { type: Number, default: 0 },
      lastReset: { type: Date, default: Date.now },
    },
  },
  resumes:    [resumeSubSchema],
}, { timestamps: true });
profileSchema.index({ email: 1 });
const Profile = mongoose.model("Profile", profileSchema);

// ── Clerk Auth Middleware ─────────────────────────────────────
const { verifyToken } = require('@clerk/backend');

async function clerkAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    let token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.query.token;
    if (!token) {
      return res.status(401).json({ success: false, error: "Missing or invalid Authorization header" });
    }
    const jwtPayload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    req.auth = {
      userId: jwtPayload.sub,
      sessionId: jwtPayload.sid,
      claims: jwtPayload,
    };
    console.log(`[Clerk Auth] Verified: userId=${jwtPayload.sub}`);
    next();
  } catch (err) {
    console.error("[Clerk Auth] Verification failed:", err.message);
    return res.status(401).json({ success: false, error: "Invalid or expired session token: " + err.message });
  }
}

async function clerkAuthOptional(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const jwtPayload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      req.auth = {
        userId: jwtPayload.sub,
        sessionId: jwtPayload.sid,
        claims: jwtPayload,
      };
    }
  } catch (_) {}
  next();
}

function getViewJobsLimitForPlan(plan) {
  const rawLimit = PLAN_LIMITS[plan]?.viewJobs;
  if (rawLimit === Infinity) return Infinity;

  const limit = Number(rawLimit);
  if (Number.isFinite(limit) && limit > 0) return limit;

  const fallback = Number(PLAN_LIMITS.free?.viewJobs);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 10;
}

async function resolveJobListingAccess(req) {
  let plan = "free";

  if (req.auth?.userId) {
    const profile = await Profile.findOne({ clerkId: req.auth.userId }).select("plan").lean();
    plan = profile?.plan || "free";
  }

  return {
    plan,
    planLimit: getViewJobsLimitForPlan(plan),
  };
}

const app = express();
const PORT = process.env.PORT || 5000;

// Load altacv.cls once at startup (lives in careerforge/public/resume-builder/)
const altacvCls = fs.readFileSync("../frontend/careerforge/public/resume-builder/altacv.cls", "utf8");

// Middleware
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Origin", "Accept"],
  optionsSuccessStatus: 204,
};

app.use((req, res, next) => {
  const origin = req.headers.origin || "(no origin)";
  if (req.method === "OPTIONS") {
    console.log(`[CORS] Preflight ${req.method} ${req.originalUrl} origin=${origin}`);
  } else {
    console.log(`[CORS] Request ${req.method} ${req.originalUrl} origin=${origin}`);
  }
  next();
});

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin || "(no origin)";
  console.log(`[API CORS] ${req.method} ${req.originalUrl} origin=${origin}`);

  if (req.headers.origin) {
    res.header("Access-Control-Allow-Origin", req.headers.origin);
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Origin, Accept");
  res.header("Vary", "Origin");

  if (req.method === "OPTIONS") {
    console.log(`[API CORS] Preflight handled for ${req.originalUrl}`);
    return res.sendStatus(204);
  }

  next();
});
app.use(express.json({ limit: "200mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

// ── Cloudinary Config ──────────────────────────────────────────
const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function enrichResume(r) {
  const doc = r.toObject ? r.toObject() : { ...r };
  if (doc._id) {
    doc.viewUrl = `/api/profile/resumes/${doc._id}/pdf?dl=0`;
    doc.downloadUrl = `/api/profile/resumes/${doc._id}/pdf?dl=1`;
  }
  return doc;
}

function enrichProfile(p) {
  const doc = p.toObject ? p.toObject() : { ...p };
  doc.resumes = (doc.resumes || []).map(enrichResume);
  return doc;
}

// ── Profile API Routes ────────────────────────────────────────

// GET /api/profile — fetch the authenticated user's profile
app.get("/api/profile", clerkAuth, async (req, res) => {
  try {
    let profile = await Profile.findOne({ clerkId: req.auth.userId });
    if (!profile) {
      return res.json({ success: false, error: "Profile not found. Create one first." });
    }
    res.json({ success: true, profile: enrichProfile(profile) });
  } catch (err) {
    console.error("[Profile] Get error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/profile — create or upsert profile (auto-create on first sign-in)
app.post("/api/profile", clerkAuth, async (req, res) => {
  try {
    const { email, username, firstName, lastName } = req.body || {};
    const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
    const role = email && email.toLowerCase() === adminEmail ? "admin" : "user";

    const profile = await Profile.findOneAndUpdate(
      { clerkId: req.auth.userId },
      {
        $setOnInsert: {
          clerkId: req.auth.userId,
          email: email || "",
          username: username || "",
          firstName: firstName || "",
          lastName: lastName || "",
          role,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    res.json({ success: true, profile: enrichProfile(profile) });
  } catch (err) {
    console.error("[Profile] Create error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/profile — update profile fields (email, username, etc.)
app.put("/api/profile", clerkAuth, async (req, res) => {
  try {
    const updates = {};
    const allowed = ["email", "username", "firstName", "lastName"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.email) {
      const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
      updates.role = updates.email.toLowerCase() === adminEmail ? "admin" : "user";
    }
    const profile = await Profile.findOneAndUpdate(
      { clerkId: req.auth.userId },
      { $set: updates },
      { returnDocument: 'after' }
    );
    if (!profile) {
      return res.status(404).json({ success: false, error: "Profile not found" });
    }
    res.json({ success: true, profile: enrichProfile(profile) });
  } catch (err) {
    console.error("[Profile] Update error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/profile/resumes — get saved resumes
app.get("/api/profile/resumes", clerkAuth, async (req, res) => {
  try {
    const profile = await Profile.findOne({ clerkId: req.auth.userId });
    if (!profile) return res.json({ success: true, resumes: [] });
    res.json({ success: true, resumes: (profile.resumes || []).map(enrichResume) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/profile/resumes — save a new resume
app.post("/api/profile/resumes", clerkAuth, async (req, res) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ success: false, error: "title and content are required" });
    }
    const profile = await Profile.findOneAndUpdate(
      { clerkId: req.auth.userId },
      { $push: { resumes: { title, content } } },
      { returnDocument: 'after' }
    );
    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });
    const saved = profile.resumes[profile.resumes.length - 1];
    res.json({ success: true, resume: enrichResume(saved) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/profile/resumes/:id — delete a saved resume
app.delete("/api/profile/resumes/:id", clerkAuth, async (req, res) => {
  try {
    const profile = await Profile.findOne(
      { clerkId: req.auth.userId }
    );
    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });

    const resume = profile.resumes.id(req.params.id);
    if (resume && resume.cloudinaryPublicId) {
      await cloudinary.uploader.destroy(resume.cloudinaryPublicId, { resource_type: 'image' }).catch(() => {});
    }

    await Profile.findOneAndUpdate(
      { clerkId: req.auth.userId },
      { $pull: { resumes: { _id: req.params.id } } },
      { returnDocument: 'after' }
    );
    res.json({ success: true, message: "Resume deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/profile/resumes/upload — upload a PDF resume to Cloudinary
app.post("/api/profile/resumes/upload", clerkAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file provided" });
    }
    const title = req.body.title || req.file.originalname.replace(/\.pdf$/i, '') || "Untitled Resume";

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'resumes',
          public_id: `${req.auth.userId}_${Date.now()}`,
          resource_type: 'raw',
        },
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const profile = await Profile.findOneAndUpdate(
      { clerkId: req.auth.userId },
      {
        $push: {
          resumes: {
            title,
            cloudinaryUrl: result.secure_url,
            cloudinaryPublicId: result.public_id,
          }
        }
      },
      { returnDocument: 'after' }
    );

    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });
    const saved = profile.resumes[profile.resumes.length - 1];
    res.json({ success: true, resume: enrichResume(saved) });
  } catch (err) {
    console.error("[Profile] Upload error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/profile/resumes/:id/pdf — proxy PDF from Cloudinary with correct Content-Type
app.get("/api/profile/resumes/:id/pdf", clerkAuth, async (req, res) => {
  try {
    const profile = await Profile.findOne({ clerkId: req.auth.userId });
    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });

    const resume = profile.resumes.id(req.params.id);
    if (!resume || !resume.cloudinaryUrl) {
      return res.status(404).json({ success: false, error: "Resume not found" });
    }

    const isDownload = req.query.dl === '1';
    const cloudResp = await axios({
      method: 'GET',
      url: resume.cloudinaryUrl,
      responseType: 'stream',
    });

    res.set('Content-Type', 'application/pdf');
    if (isDownload) {
      const filename = encodeURIComponent(resume.title || 'resume.pdf');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
    } else {
      res.set('Content-Disposition', 'inline');
    }
    cloudResp.data.pipe(res);
  } catch (err) {
    console.error("[Profile] PDF proxy error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Configuration from .env
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = process.env.GROQ_API_URL;
const GROQ_MODEL = process.env.GROQ_MODEL;

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_TTS_URL = process.env.SARVAM_TTS_URL;
const SARVAM_STT_URL = process.env.SARVAM_STT_URL;

if (!GROQ_API_KEY || !SARVAM_API_KEY) {
  console.error("ERROR: Missing required environment variables");
  process.exit(1);
}

// ── Groq API Call ───────────────────────────────────────────
async function callGroqAI(userMsg, systemMsg, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        GROQ_API_URL,
        {
          model: GROQ_MODEL,
          messages: [
            { role: "system", content: systemMsg },
            { role: "user", content: userMsg },
          ],
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROQ_API_KEY}`,
          },
        }
      );
      return response.data.choices?.[0]?.message?.content?.trim() || "";
    } catch (error) {
      if (error.response?.status === 429 && attempt < retries) {
        const wait = Math.pow(2, attempt) * 1000;
        console.warn(`Groq rate limited (429), retrying in ${wait}ms (attempt ${attempt}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.error("Groq API Error:", error.message);
      throw new Error(`Groq API Error: ${error.message}`);
    }
  }
}

// ── Sarvam TTS ───────────────────────────────────────────────
async function textToSpeech(text) {
  try {
    const response = await axios.post(
      "https://api.sarvam.ai/text-to-speech",
      { text, target_language_code: "en-IN", speaker: "simran", model: "bulbul:v3", pace: 1.2 },
      { headers: { "Content-Type": "application/json", "api-subscription-key": SARVAM_API_KEY } }
    );
    if (response.data?.audios?.length > 0) return response.data.audios[0];
    throw new Error("No audio in response");
  } catch (error) {
    console.error("Sarvam TTS Error:", error.message);
    throw new Error(`Text-to-Speech Error: ${error.message}`);
  }
}

// ── Sarvam STT ────────────────────────────────────────────────
async function transcribeRest(audioBuffer, mimeType) {
  const FormData = require("form-data");
  const form = new FormData();
  let ext = "wav";
  if (mimeType && mimeType.includes("webm")) ext = "webm";
  else if (mimeType && mimeType.includes("ogg")) ext = "ogg";
  else if (mimeType && mimeType.includes("mpeg")) ext = "mp3";
  form.append("file", audioBuffer, `audio.${ext}`);
  form.append("model", "saaras:v3");
  form.append("language_code", "en-IN");
  form.append("mode", "transcribe");
  const response = await axios.post("https://api.sarvam.ai/speech-to-text", form, {
    headers: { ...form.getHeaders(), "api-subscription-key": SARVAM_API_KEY },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return response.data?.transcript || "";
}

async function transcribeBatch(audioBuffer, mimeType) {
  const SARVAM_BASE = "https://api.sarvam.ai";
  const headers = { "api-subscription-key": SARVAM_API_KEY };

  console.log("Creating batch job...");
  const { data: jobData } = await axios.post(
    `${SARVAM_BASE}/speech-to-text/job/v1`,
    { job_parameters: { model: "saaras:v3", mode: "transcribe", language_code: "en-IN" } },
    { headers: { ...headers, "Content-Type": "application/json" } }
  );
  const jobId = jobData.job_id;
  console.log(`Batch job created: ${jobId}`);

  let ext = "wav";
  if (mimeType?.includes("webm")) ext = "webm";
  else if (mimeType?.includes("ogg")) ext = "ogg";
  else if (mimeType?.includes("mpeg")) ext = "mp3";
  const fileName = `audio.${ext}`;

  const { data: uploadData } = await axios.post(
    `${SARVAM_BASE}/speech-to-text/job/v1/upload-files`,
    { job_id: jobId, files: [fileName] },
    { headers: { ...headers, "Content-Type": "application/json" } }
  );

  const presignedEntry = uploadData.upload_urls?.[fileName] || Object.values(uploadData.upload_urls || {})[0];
  const presignedUrl = presignedEntry?.file_url || presignedEntry?.url || presignedEntry?.upload_url
    || presignedEntry?.presigned_url || (typeof presignedEntry === "string" ? presignedEntry : null);
  if (!presignedUrl) throw new Error(`Could not resolve presigned URL. Full response: ${JSON.stringify(uploadData)}`);

  await axios.put(presignedUrl, audioBuffer, {
    headers: { "Content-Type": mimeType || "audio/wav", "x-ms-blob-type": "BlockBlob" },
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });

  await axios.post(`${SARVAM_BASE}/speech-to-text/job/v1/${jobId}/start`, {},
    { headers: { ...headers, "Content-Type": "application/json" } });

  const startTime = Date.now();
  const maxWaitMs = 5 * 60 * 1000;
  let finalStatus = null;

  while (Date.now() - startTime < maxWaitMs) {
    const { data: statusData } = await axios.get(`${SARVAM_BASE}/speech-to-text/job/v1/${jobId}/status`, { headers });
    const jobState = statusData.job_state;
    console.log(`  Job state: ${jobState}`);
    if (jobState === "Completed") { finalStatus = statusData; break; }
    if (jobState === "Failed") throw new Error(`Batch job failed: ${statusData.error_message || "unknown error"}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (!finalStatus) throw new Error("Batch job timed out after 5 minutes");

  const outputFileNames = (finalStatus.job_details || [])
    .filter(d => d.state === "Success")
    .flatMap(d => (d.outputs || []).map(o => o.file_name));
  if (outputFileNames.length === 0) throw new Error("No output files in completed job");

  const { data: downloadData } = await axios.post(
    `${SARVAM_BASE}/speech-to-text/job/v1/download-files`,
    { job_id: jobId, files: outputFileNames },
    { headers: { ...headers, "Content-Type": "application/json" } }
  );

  const transcriptTexts = [];
  for (const [fn, entry] of Object.entries(downloadData.download_urls || {})) {
    const downloadUrl = entry?.file_url || entry?.url || (typeof entry === "string" ? entry : null);
    if (!downloadUrl) { console.warn(`No download URL for ${fn}`); continue; }
    const { data: transcriptJson } = await axios.get(downloadUrl);
    const text = transcriptJson?.transcript
      || transcriptJson?.text
      || (Array.isArray(transcriptJson?.chunks) ? transcriptJson.chunks.map(c => c.transcript || c.text).join(" ") : null)
      || JSON.stringify(transcriptJson);
    transcriptTexts.push(text);
  }

  if (transcriptTexts.length === 0) throw new Error("No transcription results returned");
  return transcriptTexts.join(" ");
}

async function speechToText(input, mimeType) {
  try {
    let audioBuffer;
    if (Buffer.isBuffer(input)) audioBuffer = input;
    else if (typeof input === "string") audioBuffer = Buffer.from(input, "base64");
    else throw new Error("Invalid audio input");

    const estimatedSeconds = (audioBuffer.byteLength / 50000) * 10;
    console.log(`Audio size: ${(audioBuffer.byteLength / 1024).toFixed(1)}KB, ~${estimatedSeconds.toFixed(1)}s`);

    if (estimatedSeconds < 30) return await transcribeRest(audioBuffer, mimeType);
    else return await transcribeBatch(audioBuffer, mimeType);
  } catch (error) {
    if (error.response) console.error("Sarvam STT Response Error:", error.response.status, error.response.data);
    else console.error("Sarvam STT Error:", error.message);
    throw new Error(`Speech-to-Text Error: ${error.message}`);
  }
}

// ── Resume Builder Functions ─────────────────────────────────

function buildJakeLatex(d, escape) {
  const section = (title, content) =>
    content.trim() ? `\\section{${title}}\n${content}\n\\vspace{4pt}\n` : "";

  const skillLines = (d.skills || []).map((s) => `  \\resumeItem{${escape(s)}}`).join("\n");
  const skillsSection = section("Technical Skills",
    skillLines ? `\\resumeItemListStart\n${skillLines}\n\\resumeItemListEnd` : "");

  const expContent = (d.experience || []).map((e) => {
    const elink = e.link?.trim() || "";
    const bullets = (e.bullets || []).map((b) => `\\resumeItem{${escape(b)}}`).join("\n");
    const topRight    = elink ? `\\href{${elink}}{\\textbf{Link}}` : escape(e.date);
    const bottomRight = elink ? `{\\small ${escape(e.date)}}` : "";
    return `
\\item
\\begin{tabular*}{1.0\\textwidth}{l@{\\extracolsep{\\fill}}r}
  \\textbf{${escape(e.title)} --- ${escape(e.org)}} & {\\small ${topRight}} \\\\
  {\\small ${escape(e.tech)}} & ${bottomRight} \\\\
\\end{tabular*}
  \\resumeItemListStart
${bullets}
  \\resumeItemListEnd
  \\vspace{7pt}`;
  }).join("\n");
  const expSection = section("Experience",
    expContent ? `\\resumeSubHeadingListStart\n${expContent}\n\\resumeSubHeadingListEnd` : "");

  const projContent = (d.projects || []).map((p) => {
    const plink = p.link?.trim() || "";
    const bullets     = (p.bullets || []).map((b) => `\\resumeItem{${escape(b)}}`).join("\n");
    const topRight    = plink ? `\\href{${plink}}{\\textbf{Live Demo}}` : escape(p.date);
    const bottomRight = plink ? `{\\small ${escape(p.date)}}` : "";
    return `
  \\item
    \\begin{tabular*}{1.0\\textwidth}{l@{\\extracolsep{\\fill}}r}
      \\textbf{${escape(p.name)}} & {\\small ${topRight}} \\\\
      {\\small ${escape(p.tech)}} & ${bottomRight} \\\\
    \\end{tabular*}
    \\resumeItemListStart
${bullets}
    \\resumeItemListEnd`;
  }).join("\n");
  const projSection = section("Projects",
    projContent ? `\\resumeSubHeadingListStart\n${projContent}\n\\resumeSubHeadingListEnd` : "");

  const eduContent = (d.education || []).map((e) => `
  \\item
    \\textbf{${escape(e.institution)}} \\hfill ${escape(e.date)} \\\\
    \\small ${escape(e.degree)}`).join("\n");
  const eduSection = section("Education",
    eduContent ? `\\resumeSubHeadingListStart\n${eduContent}\n\\resumeSubHeadingListEnd` : "");

  const certLines = (d.certifications || []).map((c) => `  \\resumeItem{\\textbf{${escape(c)}}}`).join("\n");
  const certSection = section("Certifications",
    certLines ? `\\resumeItemListStart\n${certLines}\n\\resumeItemListEnd` : "");

  const summarySection = d.summary ? `\\section*{Summary}\n\\noindent ${escape(d.summary)}\n` : "";

  return `%-------------------------
% Resume in Latex --- Auto-generated by ResumeX
%------------------------
\\documentclass[letterpaper,10.5pt]{article}
\\usepackage[pdfnewwindow,hidelinks]{hyperref}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{fontawesome5}
\\usepackage{multicol}
\\setlength{\\multicolsep}{-3.0pt}
\\setlength{\\columnsep}{-1pt}
\\input{glyphtounicode}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\addtolength{\\oddsidemargin}{-0.6in}
\\addtolength{\\evensidemargin}{-0.5in}
\\addtolength{\\textwidth}{1.19in}
\\addtolength{\\topmargin}{-.7in}
\\addtolength{\\textheight}{1.4in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{
  \\vspace{-4pt}\\scshape\\raggedright\\large\\bfseries
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-5pt}]

\\pdfgentounicode=1

\\newcommand{\\resumeItem}[1]{\\item\\small{{#1 \\vspace{-2pt}}}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}[leftmargin=1.5em,label=\\textbullet,nosep]}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-5pt}}
\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0.0in,label={}]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}

\\begin{document}

%----------HEADING----------
\\begin{center}
  {\\Huge \\scshape ${escape(d.name)}} \\\\ \\vspace{2pt}
  ${escape(d.location)} \\\\ \\vspace{2pt}
  \\small \\raisebox{-0.1\\height}\\faPhone\\ ${escape(d.phone)} ~
  \\href{mailto:${escape(d.email)}}{\\raisebox{-0.2\\height}\\faEnvelope\\  ${escape(d.email)}} ~
  ${d.linkedin ? `\\href{https://${d.linkedin}}{\\raisebox{-0.2\\height}\\faLinkedin\\ \\underline{linkedin}} ~` : ""}
  ${d.github ? `\\href{https://${d.github}}{\\raisebox{-0.2\\height}\\faGithub\\ \\underline{GitHub}}` : ""}
  \\vspace{-8pt}
\\end{center}

${summarySection}
${skillsSection}
${expSection}
${projSection}
${certSection}
${eduSection}

\\end{document}`;
}

// ── AltaCV sidebar (page1sidebar.tex) ───────────────────────
function buildAltaCVSidebarTex(d, escape) {
  const skillLines = (d.skills || []).map((s) => `\\cvtag{${escape(s)}}`).join("\n");
  const certLines  = (d.certifications || []).map((c) => `\\cvachievement{\\faTrophy}{${escape(c)}}{}`).join("\n");
  let out = "";
  if (skillLines) out += `\\cvsection{Skills}\n${skillLines}\n\n`;
  if (certLines)  out += `\\cvsection{Certifications}\n${certLines}\n`;
  return out;
}

// ── AltaCV main document ─────────────────────────────────────
function buildAltaCVLatex(d, escape) {
  const expBlocks = (d.experience || []).map((e) => `
\\cvevent{${escape(e.title)}}{${escape(e.org)}}{${escape(e.date)}}{}
\\begin{itemize}
${(e.bullets || []).map((b) => `\\item ${escape(b)}`).join("\n")}
\\end{itemize}
\\divider`).join("\n");

  const projBlocks = (d.projects || []).map((p) => {
    const linkLine = p.link ? `\n\\printinfo{\\faLink}{\\href{${p.link}}{Live Demo}}` : "";
    return `
\\cvevent{${escape(p.name)}}{${escape(p.tech || "")}}{${escape(p.date)}}{}${linkLine}
\\begin{itemize}
${(p.bullets || []).map((b) => `\\item ${escape(b)}`).join("\n")}
\\end{itemize}
\\divider`;
  }).join("\n");

  const eduBlocks = (d.education || []).map((e) => `
\\cvevent{${escape(e.degree)}}{${escape(e.institution)}}{${escape(e.date)}}{}
\\divider`).join("\n");

  const tagline = escape(d.summary ? d.summary.split(".")[0] : "");

  // [page1sidebar] loads the sidebar file — critical for two-column layout
  const expSection  = `\\cvsection[page1sidebar]{Experience}\n${expBlocks}`;
  const projSection = projBlocks.trim() ? `\\cvsection{Projects}\n${projBlocks}` : "";
  const eduSection  = eduBlocks.trim()  ? `\\cvsection{Education}\n${eduBlocks}` : "";

  return `\\PassOptionsToPackage{dvipsnames}{xcolor}
\\documentclass[10pt,a4paper]{altacv}
\\geometry{left=1cm,right=9cm,marginparwidth=6.8cm,marginparsep=1.2cm,top=1.25cm,bottom=1.25cm,footskip=2\\baselineskip}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage[default]{lato}
\\definecolor{Navy}{HTML}{000080}
\\definecolor{SlateGrey}{HTML}{2E2E2E}
\\definecolor{LightGrey}{HTML}{666666}
\\colorlet{heading}{Navy}
\\colorlet{accent}{Navy}
\\colorlet{emphasis}{SlateGrey}
\\colorlet{body}{LightGrey}
\\renewcommand{\\itemmarker}{{\\small\\textbullet}}
\\renewcommand{\\ratingmarker}{\\faCircle}
\\usepackage[colorlinks]{hyperref}

\\begin{document}

\\name{${escape(d.name)}}
\\tagline{${tagline}}
\\personalinfo{%
  \\email{${escape(d.email)}}
  \\phone{${escape(d.phone)}}
  \\location{${escape(d.location || "")}}
  \\linkedin{${escape(d.linkedin)}}
  \\github{${escape(d.github)}}
}
\\begin{fullwidth}
\\makecvheader
\\end{fullwidth}

${expSection}

${projSection}

${eduSection}

\\end{document}`;
}

// ── Academic Style LaTeX ─────────────────────────────────────
function buildAcademicLatex(d, escape) {
  const name    = escape(d.name || "");
  const phone   = escape(d.phone || "");
  const email   = escape(d.email || "");
  const github  = escape(d.github || "");
  const linkedin = escape(d.linkedin || "");
  const location = escape(d.location || "");

  const eduTableRows = (d.education || []).map((e) => {
    const deg = escape(e.degree || "Degree");
    const inst = escape(e.institution || "Institution");
    const yr = escape(e.date || "Year");
    return `  \\hline\n  ${deg} & ${inst} & ${yr} \\\\`;
  }).join("\n");
  const eduTable = eduTableRows || `  \\hline\n  Degree & Institution & Year \\\\`;

  const expContent = (d.experience || []).map((e) => {
    const bullets = (e.bullets || []).map((b) => `        \\item {${escape(b)}}`).join("\n");
    return `
    \\resumeSubheading
      {${escape(e.org || "Company")}}{${escape(e.date || "")}}
      {${escape(e.title || "Role")}}{${escape(e.tech || "")}}
      \\resumeItemListStart
${bullets}
    \\resumeItemListEnd`;
  }).join("\n");
  const expSection = expContent
    ? `\n\\section{Experience}\n\\resumeSubHeadingListStart\n${expContent}\n\\resumeSubHeadingListEnd\n\\vspace{-5.5mm}`
    : "";

  const projContent = (d.projects || []).map((p) => {
    const bullets = (p.bullets || []).map((b) => `        \\item {${escape(b)}}`).join("\n");
    const link = p.link ? `{\\href{${p.link}}{Link}}` : "";
    return `
    \\resumeProject
      {${escape(p.name || "Project")}}
      {${escape(p.tech || "")}}
      {${escape(p.date || "")}}
      {${link}}
      \\resumeItemListStart
${bullets}
    \\resumeItemListEnd`;
  }).join("\n");
  const projSection = projContent
    ? `\n\\section{Projects}\n\\resumeSubHeadingListStart\n${projContent}\n\\resumeSubHeadingListEnd\n\\vspace{-5.5mm}`
    : "";

  const skillItems = (d.skills || []).map((s) => {
    const parts = s.split(":").map((p) => p.trim());
    if (parts.length >= 2) return `  \\resumeSubItem{${escape(parts[0])}}{${escape(parts.slice(1).join(": "))}}`;
    return `  \\resumeSubItem{Skills}{${escape(s)}}`;
  }).join("\n");
  const skillsSection = skillItems
    ? `\n\\section{Skills}\n\\resumeHeadingSkillStart\n${skillItems}\n\\resumeHeadingSkillEnd`
    : "";

  const certItems = (d.certifications || []).map((c) =>
    `\\resumePOR{${escape(c)}}{}{}`
  ).join("\n");
  const certSection = certItems
    ? `\n\\section{Achievements}\n\\resumeSubHeadingListStart\n${certItems}\n\\resumeSubHeadingListEnd\n\\vspace{-6mm}`
    : "";

  const extraLines = (d.extracurricular || [])
    .filter((x) => typeof x === "string" && x.trim())
    .map((e) => `\\resumePOR{${escape(e)}}{}{}`);
  const extraSection = extraLines.length
    ? `\n\\section{Extracurriculars}\n\\resumeSubHeadingListStart\n${extraLines.join("\n")}\n\\resumeSubHeadingListEnd\n\\vspace{-4mm}`
    : "";

  return `%-------------------------
% Resume in Latex
% Author : Arkadeep Das, Manas Daruka, Ayush Sharma, Abhinav Gupta
% License : MIT
%------------------------

\\documentclass[a4paper,11pt]{article}
\\usepackage{latexsym}
\\usepackage{xcolor}
\\usepackage{float}
\\usepackage{ragged2e}
\\usepackage[empty]{fullpage}
\\usepackage{wrapfig}
\\usepackage{lipsum}
\\usepackage{tabularx}
\\usepackage{titlesec}
\\usepackage{geometry}
\\usepackage{marvosym}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage{multicol}
\\usepackage{graphicx}
\\usepackage{cfr-lm}
\\usepackage[T1]{fontenc}
\\setlength{\\multicolsep}{0pt}
\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}
\\geometry{left=1.4cm, top=0.8cm, right=1.2cm, bottom=1cm}
\\usepackage[most]{tcolorbox}
\\tcbset{
	frame code={}
	center title,
	left=0pt,
	right=0pt,
	top=0pt,
	bottom=0pt,
	colback=gray!20,
	colframe=white,
	width=\\dimexpr\\textwidth\\relax,
	enlarge left by=-2mm,
	boxsep=4pt,
	arc=0pt,outer arc=0pt,
}

\\urlstyle{same}

\\raggedright
\\setlength{\\tabcolsep}{0in}

\\titleformat{\\section}{
  \\vspace{-4pt}\\scshape\\raggedright\\large
}{}{0em}{}[\\color{black}\\titlerule \\vspace{-7pt}]

\\newcommand{\\resumeItem}[2]{
  \\item{
    \\textbf{#1}{:\\hspace{0.5mm}#2 \\vspace{-0.5mm}}
  }
}

\\newcommand{\\resumePOR}[3]{
\\vspace{0.5mm}\\item
    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
        \\textbf{#1},\\hspace{0.3mm}#2 & \\textit{\\small{#3}}
    \\end{tabular*}
    \\vspace{-2mm}
}

\\newcommand{\\resumeSubheading}[4]{
\\vspace{0.5mm}\\item
    \\begin{tabular*}{0.98\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
        \\textbf{#1} & \\textit{\\footnotesize{#4}} \\\\
        \\textit{\\footnotesize{#3}} &  \\footnotesize{#2}\\\\
    \\end{tabular*}
    \\vspace{-2.4mm}
}

\\newcommand{\\resumeProject}[4]{
\\vspace{0.5mm}\\item
    \\begin{tabular*}{0.98\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
        \\textbf{#1} & \\textit{\\footnotesize{#3}} \\\\
        \\footnotesize{\\textit{#2}} & \\footnotesize{#4}
    \\end{tabular*}
    \\vspace{-2.4mm}
}

\\newcommand{\\resumeSubItem}[2]{\\resumeItem{#1}{#2}\\vspace{-4pt}}

\\renewcommand{\\labelitemi}{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}

\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=*,labelsep=0mm]}
\\newcommand{\\resumeHeadingSkillStart}{\\begin{itemize}[leftmargin=*,itemsep=1.7mm, rightmargin=2ex]}
\\newcommand{\\resumeItemListStart}{\\begin{justify}\\begin{itemize}[leftmargin=3ex, rightmargin=2ex, noitemsep,labelsep=1.2mm,itemsep=0mm]\\small}

\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}\\vspace{2mm}}
\\newcommand{\\resumeHeadingSkillEnd}{\\end{itemize}\\vspace{-2mm}}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\end{justify}\\vspace{-2mm}}
\\newcommand{\\cvsection}[1]{%
\\vspace{2mm}
\\begin{tcolorbox}
    \\textbf{\\large #1}
\\end{tcolorbox}
    \\vspace{-4mm}
}

\\newcolumntype{L}{>{\\raggedright\\arraybackslash}X}%
\\newcolumntype{R}{>{\\raggedleft\\arraybackslash}X}%
\\newcolumntype{C}{>{\\centering\\arraybackslash}X}%

\\begin{document}
\\fontfamily{cmr}\\selectfont

%----------HEADING-----------------
\\parbox{2.35cm}{%
}\\parbox{\\dimexpr\\linewidth-2.8cm\\relax}{
\\begin{tabularx}{\\linewidth}{L r}
  \\textbf{\\LARGE ${name}} & +91-${phone}\\\\
  & \\href{mailto:${email}}{${email}} \\\\
  & \\href{https://github.com/${github}}{Github} \\\\
  & \\href{https://www.linkedin.com/in/${linkedin}}{linkedin.com/in/${linkedin}}
\\end{tabularx}
}

\\section{Education}
\\setlength{\\tabcolsep}{5pt}
\\small{\\begin{tabularx}
{\\dimexpr\\textwidth-3mm\\relax}{|c|C|c|}
  \\hline
  \\textbf{Degree} & \\textbf{Institute} & \\textbf{Year}\\\\
${eduTable}
  \\hline
\\end{tabularx}}
\\vspace{-2mm}
${expSection}
${projSection}
${skillsSection}
${certSection}
${extraSection}

\\end{document}`;
}

// ── Scheduled Jobs ───────────────────────────────────────────

/**
 * Run the JobSpy scraper and upsert results into MongoDB.
 * Called by the daily cron job and optionally via /api/run-fetch.
 */
async function runJobFetch() {
  console.log("[Scheduler] Starting daily job fetch...");
  const scriptPath = path.join(__dirname, "scrape_jobs.py");

  const allTerms = [
    "software engineer", "full stack developer",
    "backend developer", "frontend developer", "internship",
    "data scientist", "devops engineer", "web developer",
  ];

  const argsObj = {
    search_terms: allTerms,
    location: "India",
    results_wanted: 500,
    adzuna_app_id: process.env.ADZUNA_APP_ID || "",
    adzuna_key: process.env.ADZUNA_API_KEY || "",
  };

  try {
    // Use spawn to avoid Windows shell escaping issues with JSON
    let totalSaved = 0;
    let stdoutBuffer = "";
    let lastPartial = null;
    let pendingOps = 0;

    const proc = spawn("python", [scriptPath, JSON.stringify(argsObj)], {
      timeout: 3600000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr.on("data", (chunk) => console.error("[Scraper stderr]", chunk.toString().trim()));

    // Extract complete JSON lines from stdout buffer and process them
    function onStdoutData(chunk) {
      stdoutBuffer += chunk.toString();
      const parts = stdoutBuffer.split("\n");
      stdoutBuffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        pendingOps++;
        processLine(line).finally(() => { pendingOps--; });
      }
    }

    async function processLine(line) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && parsed.success && Array.isArray(parsed.jobs)) {
          lastPartial = parsed;
          const jobs = parsed.jobs;
          console.log(`[Scheduler] Batch: ${jobs.length} jobs. Saving...`);
          let saved = 0;
          for (const job of jobs) {
            const uniqueId = `${job.source || "jobspy"}-${job.title}-${job.company}-${job.location}`
              .replace(/[^a-zA-Z0-9]/g, "-").toLowerCase().slice(0, 100);
            await Job.findOneAndUpdate(
              { uniqueId },
              { ...job, uniqueId, fetchedAt: new Date() },
              { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
            );
            saved++;
          }
          totalSaved += saved;
          const dbTotal = await Job.countDocuments();
          console.log(`[Scheduler] Saved ${saved} jobs this batch (${totalSaved} total). DB total: ${dbTotal}`);
        }
      } catch (_) {
        // not JSON, skip
      }
    }

    proc.stdout.on("data", onStdoutData);

    // Wait for process to finish AND all pending saves to complete
    await new Promise((resolve, reject) => {
      proc.on("close", async (code) => {
        // Wait for any in-flight saves to finish
        const waitForPending = () => new Promise((r) => {
          const check = () => {
            if (pendingOps <= 0) { r(); return; }
            setImmediate(check);
          };
          setImmediate(check);
        });
        await waitForPending();

        if (code !== 0 && !lastPartial) {
          reject(new Error(`Python scraper exited with code ${code} and no jobs were saved`));
        } else {
          resolve();
        }
      });
      proc.on("error", (err) => {
        reject(new Error(`Python spawn error: ${err.message}`));
      });
    });

    console.log(`[Scheduler] Fetch complete. Total jobs saved this run: ${totalSaved}`);
  } catch (err) {
    console.error("[Scheduler] Job fetch failed:", err.message);
    throw err;
  }
}

/**
 * Delete jobs older than 7 days from MongoDB (based on datePosted).
 */
async function cleanupOldJobs() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  try {
    const result = await Job.deleteMany({ datePosted: { $lt: cutoffStr } });
    if (result.deletedCount > 0) {
      console.log(`[Cleanup] Deleted ${result.deletedCount} jobs with datePosted older than ${cutoffStr}`);
    }
  } catch (err) {
    console.error("[Cleanup] Error:", err.message);
  }
}

// ── Schedule: daily fetch at 2:00 AM ──
cron.schedule("0 2 * * *", () => {
  console.log("[Cron] Daily 2AM job fetch triggered");
  runJobFetch();
});

// ── Schedule: cleanup every hour ──
cron.schedule("0 * * * *", () => {
  cleanupOldJobs();
});

// ── Startup: purge stale jobs (before scraper max_days_old was added) ──
(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const stale = await Job.deleteMany({ datePosted: { $lt: cutoffStr } });
    if (stale.deletedCount > 0) {
      console.log(`[Startup] Purged ${stale.deletedCount} stale jobs (datePosted < ${cutoffStr})`);
    }
  } catch (_) {}
})();

// ── API Endpoints ────────────────────────────────────────────

// POST /generate-resume
app.post("/generate-resume", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: "Missing prompt" });
    const html = await callGroqAI(prompt, "Return only valid HTML. No markdown.");
    res.json({ success: true, html });
  } catch (error) {
    console.error("Generate Resume Error:", error);
    res.status(500).json({ success: false, error: "Resume generation failed" });
  }
});

// POST /generate-resume-latex
app.post("/generate-resume-latex", async (req, res) => {
  try {
    const { personalInfo, education, experience, projects, skills, extracurricular, template } = req.body;

    const groqPrompt = `
You are an ATS resume expert. Given raw user input, return ONLY a valid JSON object with these exact keys.
Polish all bullet points to be achievement-driven with metrics where possible. Do not invent facts.
Return ONLY raw JSON. No markdown, no backticks, no explanation.

CRITICAL RULES:
- Only include data the user explicitly provided. Never invent or assume.
- If ANY array field has no data, return it as [] (empty array)
- If any string field has no data, return it as "" (empty string)
- For links: only populate if the user explicitly mentioned a URL. Otherwise return ""
- If project dates are not provided, return "date": ""
- If education start year is unknown, just return the graduation year e.g. "date": "2024"
- Do NOT pad empty sections with placeholder text

Raw Input:
PERSONAL INFO: ${personalInfo}
EDUCATION: ${education}
EXPERIENCE: ${experience}
PROJECTS: ${projects}
SKILLS: ${skills}
EXTRACURRICULAR: ${extracurricular}

Return this exact JSON structure:
{
  "name": "Full Name",
  "location": "City, State",
  "phone": "+91 XXXXXXXXXX",
  "email": "email@example.com",
  "linkedin": "linkedin.com/in/username",
  "github": "github.com/username",
  "summary": "2-3 sentence ATS-optimized professional summary",
  "skills": ["Category: skill1, skill2, skill3"],
  "experience": [{"title":"","org":"","tech":"","date":"","link":"URL if mentioned","bullets":[]}],
  "projects": [{"name":"","tech":"","date":"","link":"URL if mentioned","bullets":[]}],
  "education": [{"institution":"","date":"","degree":""}],
  "certifications": []
}`;

    const raw = await callGroqAI(groqPrompt, "Return only valid JSON. No markdown. No backticks.");
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const d = JSON.parse(clean);

    const escape = (s = "") =>
      String(s)
        .replace(/\\/g, "\\textbackslash{}")
        .replace(/&/g, "\\&")
        .replace(/%/g, "\\%")
        .replace(/\$/g, "\\$")
        .replace(/#/g, "\\#")
        .replace(/_/g, "\\_")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/~/g, "\\textasciitilde{}")
        .replace(/\^/g, "\\textasciicircum{}");

    let latex, compiler, resources;
    if (template === "olivia") {
      latex    = buildAltaCVLatex(d, escape);
      compiler = "lualatex";
      resources = [
        { main: true,  path: "main.tex",        content: latex },
        { main: false, path: "altacv.cls",       content: altacvCls },
        { main: false, path: "page1sidebar.tex", content: buildAltaCVSidebarTex(d, escape) },
      ];
    } else if (template === "academic") {
      latex    = buildAcademicLatex(d, escape);
      compiler = "pdflatex";
      resources = [{ main: true, content: latex }];
    } else {
      latex    = buildJakeLatex(d, escape);
      compiler = "pdflatex";
      resources = [{ main: true, content: latex }];
    }

    const ytotechRes = await axios.post(
      "https://latex.ytotech.com/builds/sync",
      { compiler, resources },
      { headers: { "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 90000 }
    );

    const pdfBase64 = Buffer.from(ytotechRes.data).toString("base64");
    res.json({ success: true, pdf: pdfBase64, latex });
  } catch (error) {
    console.error("LaTeX Resume Error:", error.response?.data?.toString() || error.message);
    res.status(500).json({ success: false, error: "LaTeX resume generation failed: " + error.message });
  }
});

// POST /recompile-latex
app.post("/recompile-latex", async (req, res) => {
  try {
    const { latex } = req.body;
    if (!latex) return res.status(400).json({ success: false, error: "Missing latex" });
    const ytotechRes = await axios.post(
      "https://latex.ytotech.com/builds/sync",
      { compiler: "pdflatex", resources: [{ main: true, content: latex }] },
      { headers: { "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 60000 }
    );
    const pdfBase64 = Buffer.from(ytotechRes.data).toString("base64");
    res.json({ success: true, pdf: pdfBase64 });
  } catch (error) {
    console.error("Recompile LaTeX Error:", error.response?.data?.toString() || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /analyze-resume
app.post("/analyze-resume", clerkAuthOptional, checkUsageLimit("resumeAnalysis"), async (req, res) => {
  try {
    const { prompt, jobTitle, jobDescription, resumeText } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: "Missing prompt" });
    const raw = await callGroqAI(prompt, "Return only valid JSON. No markdown.");
    const jsonText = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const analysis = JSON.parse(jsonText);

    // Fire-and-forget ranking save (non-blocking, never breaks main response)
    if (req.auth && req.auth.userId) {
      _saveResumeRanking(req.auth.userId, analysis.overallScore, jobTitle, jobDescription, resumeText).catch(err => {
        console.error("Resume ranking save failed (non-fatal):", err.message);
      });
    }

    res.json({ success: true, analysis });
  } catch (error) {
    console.error("Analyze Resume Error:", error);
    res.status(500).json({ success: false, error: "Analysis failed" });
  }
});

async function _saveResumeRanking(clerkId, score, jobTitle, jobDescription, resumeText) {
  if (score === null || score === undefined || isNaN(Number(score))) {
    console.warn("[Ranking] Resume score is invalid, skipping");
    return;
  }
  const normalized = normalizeScore(Number(score));
  if (normalized === null) return;

  const category = await classifyJobCategory(jobTitle || "", jobDescription || "");
  const profile = await Profile.findOne({ clerkId });
  if (!profile) return;

  const userName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Anonymous";
  const resumeSnapshot = (resumeText || "").slice(0, 500);

  const existing = await ResumeRanking.findOne({ userId: profile._id, category });
  if (!existing || normalized > existing.resumeScore) {
    await ResumeRanking.findOneAndUpdate(
      { userId: profile._id, category },
      {
        userId: profile._id,
        userName,
        category,
        resumeScore: normalized,
        jobTitle: jobTitle || "",
        analyzedAt: new Date(),
        resumeSnapshot,
      },
      { upsert: true, new: true }
    );
  }
}

// POST /generate-job-specific-resume
app.post("/generate-job-specific-resume", clerkAuth, checkUsageLimit("jobFitResume"), async (req, res) => {
  try {
    const { resumeText, jobDescription, jobTitle } = req.body;
    if (!resumeText || !jobDescription) {
      return res.status(400).json({ success: false, error: "Missing resumeText or jobDescription" });
    }

    const groqPrompt = `
You are an ATS resume optimization engine. Your ONLY job is to lightly rewrite an existing resume to better match a job description — NOT to summarize, shorten, or add filler phrases.

═══════════════════════════════════════════════
ABSOLUTE RULES — NEVER VIOLATE THESE:
═══════════════════════════════════════════════
1. PRESERVE ALL METRICS: Every number, percentage, or quantified achievement (e.g. "~66% latency reduction", "40+ users", "92+ CI checks") MUST appear verbatim in the output. If a bullet has a metric, that metric stays.
2. PRESERVE BULLET COUNT: Each experience/project entry must have the EXACT same number of bullets as the original. Count them. Output must match. NEVER delete, merge, or collapse bullets. The last bullet is NOT optional.
3. PRESERVE BULLET LENGTH: Each rewritten bullet must be roughly the same length as the original — not longer, not shorter. Do NOT pad with extra clauses. Do NOT truncate.
4. PRESERVE TECHNICAL DEPTH: Keep all specific technical details (algorithms, architecture decisions, tool names, strategies like "round-robin", "TTL-based", "dual-layer"). Do NOT replace specifics with vague language.
5. PRESERVE PARENTHETICAL DETAILS: Never remove or rephrase content inside parentheses. Copy them exactly as-is. Examples that must be preserved verbatim: "(global + per-route)", "(tests, static analysis, builds)", "(Groq, Gemini)", "(EC2)", "(caching, rate limiting)", "(admin/user separation, protected routes)".
6. DO NOT FABRICATE: Never add skills, tools, roles, or achievements not present in the original resume.
7. DO NOT SUMMARIZE: You are NOT summarizing. You are doing light keyword substitution and rephrasing only.

═══════════════════════════════════════════════
STRICTLY FORBIDDEN PATTERNS:
═══════════════════════════════════════════════
NEVER append justification phrases to bullets. These patterns are BANNED:
- "...demonstrating my expertise in X"
- "...showcasing my skills in X"
- "...highlighting my ability to X"
- "...leveraging my understanding of X"
- Any phrase that explains WHY the bullet is relevant to the job

WRONG: "Built Redis-based caching, reducing latency by ~66% (300ms → 100ms), demonstrating my ability to optimize performance."
CORRECT: "Built Redis-based response caching, reducing average latency by ~66% (300ms → 100ms)."

The bullet should end where the original bullet ends. No additions after the core achievement.

═══════════════════════════════════════════════
BULLET COUNT VERIFICATION (MANDATORY):
═══════════════════════════════════════════════
Before returning JSON, mentally verify:
- Experience entry 1: original has N bullets → output has N bullets ✓
- Experience entry 2: original has N bullets → output has N bullets ✓
- Project entry 1: original has N bullets → output has N bullets ✓
- Project entry 2: original has N bullets → output has N bullets ✓
If any count doesn't match, fix it before returning.

═══════════════════════════════════════════════
WHAT YOU ARE ALLOWED TO DO:
═══════════════════════════════════════════════
- Rephrase the START of a bullet to use a stronger or more JD-relevant action verb
- Swap a generic word for a JD-specific synonym inline (e.g. "built" → "engineered")
- Reorder bullets within an entry to put the most JD-relevant ones first
- Add JD keywords naturally inline where they fit without changing meaning
- Rewrite the summary section to target the job role — but KEEP specific proof points like project names and contributions
- Add JD-relevant keywords to the skills section if they map to existing skills

═══════════════════════════════════════════════
TRANSFORMATION EXAMPLE:
═══════════════════════════════════════════════
ORIGINAL: "Built Redis-based response caching, reducing average latency by ~66% (300ms → 100ms)."
JD KEYWORD: "performance optimization"
CORRECT: "Engineered Redis response caching for performance optimization, reducing average latency by ~66% (300ms → 100ms)."
WRONG: "Implemented caching to improve system performance." ← TOO VAGUE, METRIC LOST, PARENTHETICAL LOST
WRONG: "Built Redis-based caching, reducing latency by ~66%, demonstrating performance optimization skills." ← APPENDED PHRASE BANNED
WRONG: "Engineered Redis response caching for performance optimization, reducing average latency by ~66%." ← PARENTHETICAL (300ms → 100ms) MUST BE KEPT

═══════════════════════════════════════════════
ORIGINAL RESUME TEXT:
${resumeText}

JOB TITLE:
${jobTitle || ""}

JOB DESCRIPTION:
${jobDescription}

═══════════════════════════════════════════════
Return ONLY valid JSON. No markdown, no backticks, no explanation.

{
  "name": "Full Name from resume",
  "location": "City, State",
  "phone": "Phone number",
  "email": "Email address",
  "linkedin": "LinkedIn username or URL",
  "github": "GitHub username or URL",
  "summary": "2-3 sentence ATS-optimized professional summary targeting this job role, keeping specific proof points like notable projects and contributions",
  "skills": ["Category: skill1, skill2, skill3"],
  "experience": [
    {
      "title": "Job Title",
      "org": "Company",
      "tech": "Tech stack — copy exactly from original including all parentheticals",
      "date": "Dates",
      "link": "",
      "bullets": [
        "Concise bullet — same length as original, metrics preserved, parentheticals preserved, no appended justification"
      ]
    }
  ],
  "projects": [
    {
      "name": "Project Name",
      "tech": "Tech stack — copy exactly from original including all parentheticals like (Groq, Gemini)",
      "date": "Date",
      "link": "URL if mentioned",
      "bullets": [
        "Concise bullet — same length as original, metrics preserved, parentheticals preserved, no appended justification"
      ]
    }
  ],
  "education": [{"institution": "University", "date": "Graduation Year (Expected) if applicable", "degree": "Degree — include CGPA if present"}],
  "certifications": ["Certification name"]
}

IMPORTANT: Include a "changes" field — an array of short specific bullets describing EVERY modification made. Each bullet must mention the section and what changed. Examples:
- "Summary: Rewritten to target 'MERN Stack Developer' role, proof points retained"
- "Skills: 'Redis (caching, rate limiting)' preserved verbatim"
- "Experience (OpenTelemetry): First bullet reworded — added 'Merged PR' as opening context"
- "Projects (Obsidian Gateway): Bullet 3 reworded — 'Built' → 'Engineered' and added 'performance optimization'"

CRITICAL: Only include data explicitly present in the resume. Reword existing bullets to match JD keywords. Do not fabricate. Populate link fields if URLs are found in the resume text. Return linkedin/github without https:// prefix.`;
    const raw = await callGroqAI(groqPrompt, "Return only valid JSON. No markdown. No backticks.");
    const clean = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const d = JSON.parse(clean);

    const escape = (s = "") =>
      String(s)
        .replace(/\\/g, "\\textbackslash{}")
        .replace(/&/g, "\\&")
        .replace(/%/g, "\\%")
        .replace(/\$/g, "\\$")
        .replace(/#/g, "\\#")
        .replace(/_/g, "\\_")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/~/g, "\\textasciitilde{}")
        .replace(/\^/g, "\\textasciicircum{}");

    const latex = buildJakeLatex(d, escape);
    const ytotechRes = await axios.post(
      "https://latex.ytotech.com/builds/sync",
      { compiler: "pdflatex", resources: [{ main: true, content: latex }] },
      { headers: { "Content-Type": "application/json" }, responseType: "arraybuffer", timeout: 90000 }
    );

    const pdfBase64 = Buffer.from(ytotechRes.data).toString("base64");

    // Build plain-text tailored resume matching original free-form format for diff
    const sections = [];
    sections.push(d.name || "");
    sections.push([d.email, d.phone, d.location].filter(Boolean).join(" | "));

    if (d.summary) { sections.push(""); sections.push(d.summary); }

    if (d.skills?.length) { sections.push(""); sections.push("Skills: " + d.skills.join(", ")); }

    for (const exp of d.experience || []) {
      sections.push("");
      sections.push([exp.title, "at", exp.org].filter(Boolean).join(" "));
      if (exp.date) sections.push(exp.date);
      if (exp.tech) sections.push("Tech: " + exp.tech);
      for (const b of exp.bullets || []) sections.push("  " + b);
    }

    for (const proj of d.projects || []) {
      sections.push("");
      sections.push("Project: " + proj.name);
      if (proj.date) sections.push(proj.date);
      if (proj.tech) sections.push("Tech: " + proj.tech);
      for (const b of proj.bullets || []) sections.push("  " + b);
    }

    for (const edu of d.education || []) {
      sections.push("");
      sections.push([edu.degree, "at", edu.institution].filter(Boolean).join(" "));
      if (edu.date) sections.push(edu.date);
    }

    if (d.certifications?.length) {
      sections.push("");
      sections.push("Certifications:");
      for (const c of d.certifications) sections.push("  " + c);
    }

    const tailoredText = sections.join("\n");

    const changes = d.changes || [];
    res.json({ success: true, pdf: pdfBase64, latex, tailored: d, tailoredText, changes });
  } catch (error) {
    console.error("Generate Job Specific Resume Error:", error.response?.data?.toString() || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/generate-shadow-mode
app.post("/api/generate-shadow-mode", async (req, res) => {
  try {
    const { questions, jobDesc, resumeText, intType, difficulty } = req.body;
    if (!questions || !Array.isArray(questions) || questions.length === 0)
      return res.status(400).json({ error: "Invalid questions array" });

    const prompt =
      `Job Description:\n${(jobDesc || "").slice(0, 3000)}\n\n` +
      `Candidate Resume:\n${(resumeText || "").slice(0, 3000)}\n\n` +
      `Interview Type: ${intType}\nDifficulty Level: ${difficulty}\n\n` +
      `You are generating ideal shadow-mode answers for a mock interview coach.\n` +
      `For each question below, write a concise, first-person answer that the candidate could realistically say.\n` +
      `Make each answer sound natural, simple, and easy to remember. Avoid jargon, fancy words, and long explanations.\n` +
      `Use only 1-3 short sentences (about 20-55 words total). Keep it specific to the resume and job description.\n` +
      `Do not use bullet points. Do not explain your reasoning.\n\n` +
      questions.map((question, index) => `${index + 1}. ${question}`).join("\n") +
      `\n\nReturn ONLY a valid JSON array of strings with exactly ${questions.length} answers. No markdown, no extra text.`;

    const sys = "You are a concise interview coach. Return only valid JSON arrays of spoken first-person answers, with no markdown or extra commentary.";
    const raw = await callGroqAI(prompt, sys);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");

    const answers = JSON.parse(match[0]);
    if (!Array.isArray(answers) || answers.length !== questions.length)
      throw new Error("Shadow answer count did not match questions");

    const audios = await Promise.all(
      answers.map((answer, index) =>
        textToSpeech(answer).catch((err) => {
          console.error(`Error generating shadow audio for question ${index + 1}:`, err);
          throw err;
        })
      )
    );
    res.json({ success: true, answers, audios });
  } catch (error) {
    console.error("Generate Shadow Mode Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/text-to-speech
app.post("/api/text-to-speech", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });
    const audio = await textToSpeech(text);
    res.json({ success: true, audio });
  } catch (error) {
    console.error("Text-to-Speech Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/generate-questions
app.post("/api/generate-questions", clerkAuth, checkUsageLimit("interviewPrep"), async (req, res) => {
  try {
    const { jobDesc, resumeText, intType, difficulty, totalQ } = req.body;
    const prompt =
      `Job Description:\n${(jobDesc || "").slice(0, 3000)}\n\n` +
      `Candidate Resume:\n${(resumeText || "").slice(0, 3000)}\n\n` +
      `Interview Type: ${intType || "technical"}\nDifficulty Level: ${difficulty || "medium"}\n` +
      `Generate exactly ${totalQ || 5} interview questions for a mock interview coach.\n` +
      `Make questions specific to the job description and resume. Vary between technical, behavioral, and situational questions.\n` +
      `Return ONLY a valid JSON array of strings. No markdown, no explanation.`;
    const sys = "You are an expert interview question generator. Return only valid JSON arrays of strings.";
    const raw = await callGroqAI(prompt, sys);
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array in response");
    const questions = JSON.parse(match[0]);
    res.json({ success: true, questions });
  } catch (error) {
    console.error("Generate Questions Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/generate-audios
app.post("/api/generate-audios", async (req, res) => {
  try {
    const { questions, prefixGreeting } = req.body;
    if (!questions || !Array.isArray(questions)) return res.status(400).json({ error: "Invalid questions array" });
    const texts = questions.map((q, i) => {
      if (i === 0 && prefixGreeting) return `${prefixGreeting} ${q}`.trim();
      return String(q || "").trim();
    });
    const audios = await Promise.all(
      texts.map((text) => textToSpeech(text).catch((err) => {
        console.error("Error generating audio:", err);
        return null;
      }))
    );
    res.json({ success: true, audios });
  } catch (error) {
    console.error("Generate Audios Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/analyze-interview
app.post("/api/analyze-interview", clerkAuthOptional, async (req, res) => {
  try {
    const { questions, answers, jobDesc, resumeText, intType, difficulty, jobTitle } = req.body;
    const qaText = questions.map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${answers[i] || "(no answer)"}`).join("\n\n");
    const prompt =
      `Job Description:\n${(jobDesc || "").slice(0, 2000)}\n\n` +
      `Candidate Resume:\n${(resumeText || "").slice(0, 2000)}\n\n` +
      `Interview Type: ${intType || "technical"}\nDifficulty: ${difficulty || "medium"}\n\n` +
      `Interview Transcript:\n${qaText}\n\n` +
      `Analyze this interview and return ONLY valid JSON with this exact structure (no markdown):\n` +
      `{\n  "overallScore": 0-100,\n  "landingChance": 0-100,\n` +
      `  "verdict": "2-3 sentence assessment",\n  "strengths": ["strength1", "strength2", "strength3"],\n` +
      `  "weaknesses": ["weakness1", "weakness2", "weakness3"],\n` +
      `  "actionSteps": ["step1", "step2", "step3", "step4"],\n` +
      `  "metrics": { "communication": 0-100, "technicalDepth": 0-100, "confidence": 0-100, "relevance": 0-100 }\n}`;
    const sys = "You are an expert interview analyst. Return only valid JSON with no markdown or extra text. Use the exact structure requested.";
    const raw = await callGroqAI(prompt, sys);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object in response");
    const analysis = JSON.parse(match[0]);

    // Fire-and-forget interview ranking save
    if (req.auth && req.auth.userId) {
      _saveInterviewRanking(req.auth.userId, analysis.overallScore, jobTitle, jobDesc, resumeText, intType, difficulty).catch(err => {
        console.error("Interview ranking save failed (non-fatal):", err.message);
      });
    }

    res.json({ success: true, analysis });
  } catch (error) {
    console.error("Analyze Interview Error:", error);
    res.status(500).json({ error: error.message });
  }
});

async function _saveInterviewRanking(clerkId, score, jobTitle, jobDescription, resumeText, intType, difficulty) {
  if (score === null || score === undefined || isNaN(Number(score))) {
    console.warn("[Ranking] Interview score is invalid, skipping");
    return;
  }
  const normalized = normalizeScore(Number(score));
  if (normalized === null) return;

  const category = await classifyJobCategory(jobTitle || "", jobDescription || "");
  const profile = await Profile.findOne({ clerkId });
  if (!profile) return;

  const userName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Anonymous";

  const existing = await InterviewRanking.findOne({ userId: profile._id, category });
  if (!existing || normalized > existing.interviewScore) {
    await InterviewRanking.findOneAndUpdate(
      { userId: profile._id, category },
      {
        userId: profile._id,
        userName,
        category,
        interviewScore: normalized,
        jobTitle: jobTitle || "",
        interviewType: intType || "",
        difficulty: difficulty || "",
        completedAt: new Date(),
      },
      { upsert: true, new: true }
    );
  }
}

// POST /api/speech-to-text
app.post("/api/speech-to-text", upload.single("file"), async (req, res) => {
  try {
    if (req.file) {
      const mime = req.file.mimetype || "audio/wav";
      const transcript = await speechToText(req.file.buffer, mime);
      return res.json({ success: true, transcript });
    }
    const { audio } = req.body;
    if (!audio) return res.status(400).json({ error: "Missing audio" });
    const transcript = await speechToText(audio);
    res.json({ success: true, transcript });
  } catch (error) {
    console.error("Speech-to-Text Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ── Job Listings ────────────────────────────────────────────

// POST /api/fetch-jobs — Return cached jobs from MongoDB (no new scraper calls)
app.post("/api/fetch-jobs", clerkAuthOptional, async (req, res) => {
  let plan = "free";
  let planLimit = getViewJobsLimitForPlan(plan);
  try {
    const { filters } = req.body;
    const query = {};
    ({ plan, planLimit } = await resolveJobListingAccess(req));

    let limit, page, skip, total;
    if (planLimit === Infinity) {
      // Max plan — full paginated access
      const requestedLimit = Math.min(parseInt(filters?.limit) || 50, 200);
      limit = requestedLimit;
      page = Math.max(parseInt(filters?.page) || 1, 1);
      skip = (page - 1) * limit;
      total = await Job.countDocuments(query);
    } else {
      // Free/Pro — fixed total cap, no pagination
      limit = planLimit;
      page = 1;
      skip = 0;
      total = Math.min(await Job.countDocuments(query), planLimit);
    }

    const jobs = await Job.find(query).sort({ fetchedAt: -1, _id: -1 }).skip(skip).limit(limit);
    res.json({
      success: true, jobs, source: "mongodb-cache",
      total, page,
      totalPages: planLimit === Infinity ? Math.ceil(total / limit) : 1,
      plan, planLimit, limit
    });
  } catch (error) {
    console.error("Fetch Jobs Error:", error.message);
    const fallbackLimit = planLimit === Infinity ? 50 : Math.max(1, Math.min(planLimit, 50));
    const cached = await Job.find().sort({ fetchedAt: -1, _id: -1 }).limit(fallbackLimit).catch(() => []);
    res.json({ success: true, jobs: cached, cached: true, plan, planLimit, limit: fallbackLimit });
  }
});

// POST /api/match-jobs — Filter & return jobs from MongoDB (no AI)
app.post("/api/match-jobs", clerkAuthOptional, async (req, res) => {
  try {
    const { filters } = req.body || {};
    console.log("[Jobs] Filters:", JSON.stringify(filters || {}));

    const query = {};
    if (filters) {
      // Title keyword searches across title, skills, AND description
      if (filters.title) {
        const escaped = filters.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "i");
        query.$or = [
          { title: regex },
          { description: regex },
          { skills: regex },
        ];
      }
      if (filters.country) {
        query.country = { $regex: new RegExp(filters.country, "i") };
      }
      if (filters.location) {
        query.location = { $regex: new RegExp(filters.location, "i") };
      }
      if (filters.experienceLevel) {
        const el = filters.experienceLevel.toLowerCase();
        if (["entry", "mid", "senior"].includes(el)) query.experienceLevel = el;
      }
      if (filters.jobType) {
        query.jobType = { $regex: new RegExp(filters.jobType, "i") };
      }
      if (filters.remote === "true") {
        query.isRemote = true;
      } else if (filters.remote === "false") {
        query.isRemote = false;
      }
      if (filters.platforms && filters.platforms.length > 0) {
        query.source = { $in: filters.platforms };
      }
      if (filters.keywords && filters.keywords.length > 0) {
        const titleConditions = filters.keywords.map(k => ({
          title: { $regex: new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
        }));
        if (query.$or) {
          query.$and = [{ $or: query.$or }, { $or: titleConditions }];
          delete query.$or;
        } else {
          query.$or = titleConditions;
        }
      }
      if (filters.hoursOld) {
        const cutoff = new Date(Date.now() - parseInt(filters.hoursOld) * 60 * 60 * 1000);
        query.datePosted = { $gte: cutoff.toISOString().slice(0, 10) };
      }
    }

    const { plan, planLimit } = await resolveJobListingAccess(req);

    let limit, page, skip, total;
    if (planLimit === Infinity) {
      // Max plan — full paginated access
      const requestedLimit = Math.min(parseInt(filters?.limit) || 50, 200);
      limit = requestedLimit;
      page = Math.max(parseInt(filters?.page) || 1, 1);
      skip = (page - 1) * limit;
      total = await Job.countDocuments(query);
    } else {
      // Free/Pro — fixed total cap, no pagination
      limit = planLimit;
      page = 1;
      skip = 0;
      total = Math.min(await Job.countDocuments(query), planLimit);
    }

    const jobs = await Job.find(query).sort({ fetchedAt: -1, _id: -1 }).skip(skip).limit(limit).lean();

    res.json({
      success: true, jobs, total, page,
      totalPages: planLimit === Infinity ? Math.ceil(total / limit) : 1,
      plan, planLimit, limit
    });
  } catch (error) {
    console.error("[Jobs] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/generate-cover-letter
app.post("/api/generate-cover-letter", clerkAuth, checkUsageLimit("coverLetter"), async (req, res) => {
  try {
    const { resumeText, jobDescription, jobTitle } = req.body;
    if (!resumeText || !jobDescription) {
      return res.status(400).json({ success: false, error: "Missing resumeText or jobDescription" });
    }

    const prompt = `
You are a professional cover letter writer. Write a concise, impactful cover letter for the given job.

RULES:
- Do not invent experience or skills not present in the resume.
- Use the candidate's actual achievements and experience.
- Keep it to 3-4 paragraphs (250-400 words).
- Address it to the hiring manager.
- Mention specific skills from the resume that match the job description.
- End with a call to action.
- Return ONLY the cover letter text. No extra commentary.

JOB TITLE: ${jobTitle || "Software Developer"}

JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}

RESUME:
${resumeText.slice(0, 3000)}

Return only the cover letter text.`;
  
    const coverLetter = await callGroqAI(prompt, "You are a cover letter writer. Return only the cover letter text, no markdown.");
    res.json({ success: true, coverLetter: coverLetter.trim() });
  } catch (error) {
    console.error("Cover Letter Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/run-fetch — Admin: manually trigger daily fetch
app.post("/api/run-fetch", clerkAuth, async (req, res) => {
  try {
    const profile = await Profile.findOne({ clerkId: req.auth.userId });
    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ success: false, error: "Admin access required" });
    }
    runJobFetch().catch((err) => console.error("[Admin Fetch] Error:", err.message));
    res.json({ success: true, message: "Job fetch started in background" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/jobs/detail/:id — Full job posting detail
app.get("/api/jobs/detail/:id", async (req, res) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ success: false, error: "Job not found" });
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/jobs/filters — Get available filter options from MongoDB
app.get("/api/jobs/filters", async (req, res) => {
  try {
    const [countries, sources, experienceLevels] = await Promise.all([
      Job.distinct("country", { country: { $ne: "" } }),
      Job.distinct("source", { source: { $ne: "" } }),
      Job.distinct("experienceLevel"),
    ]);
    res.json({
      success: true,
      filters: {
        countries: countries.filter(Boolean).sort(),
        sources: sources.filter(Boolean).sort(),
        experienceLevels: experienceLevels.filter(Boolean).sort(),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Leaderboard routes
app.use("/api/leaderboard", leaderboardRouter);

// Plans routes
app.use("/api/plans", plansRouter);

// Payment routes
app.use("/api/payment", paymentRouter);

// Health check
const startTime = Date.now();

app.get("/api/health", (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  const uptimeStr = `${days}d ${hours}h ${minutes}m ${seconds}s`;
  res.json({ status: "Server is running", port: PORT, uptime: uptimeStr, uptimeSeconds: uptime });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   AI Mock Interview Backend Server       ║
║   Running on http://localhost:${PORT}      ║
║   CORS Enabled for frontend on :3000     ║
╚═══════════════════════════════════════════╝
  `);
  console.log("latest code");
});