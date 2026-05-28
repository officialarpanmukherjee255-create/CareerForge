const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { verifyToken } = require('@clerk/backend');
const ResumeRanking = require("../models/ResumeRanking");
const InterviewRanking = require("../models/InterviewRanking");

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
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: "Invalid or expired session token" });
  }
}

function maskName(userName) {
  if (!userName || userName === "Anonymous") return "Anonymous";
  const parts = userName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + " " + (parts[parts.length - 1][0] || "") + ".";
}

// GET /api/leaderboard/categories
router.get("/categories", async (req, res) => {
  try {
    const [resumeCats, interviewCats] = await Promise.all([
      ResumeRanking.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }]),
      InterviewRanking.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }]),
    ]);

    const catMap = {};
    for (const c of resumeCats) {
      catMap[c._id] = { category: c._id, resumeCount: c.count, interviewCount: 0 };
    }
    for (const c of interviewCats) {
      if (catMap[c._id]) catMap[c._id].interviewCount = c.count;
      else catMap[c._id] = { category: c._id, resumeCount: 0, interviewCount: c.count };
    }

    const categories = Object.values(catMap).sort((a, b) =>
      (b.resumeCount + b.interviewCount) - (a.resumeCount + a.interviewCount)
    );

    res.json({ success: true, categories });
  } catch (err) {
    console.error("[Leaderboard] Categories error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/leaderboard/resume/:category
router.get("/resume/:category", async (req, res) => {
  try {
    const entries = await ResumeRanking.find({ category: req.params.category })
      .sort({ resumeScore: -1 })
      .limit(100)
      .lean();

    const ranked = entries.map((e, i) => ({
      rank: i + 1,
      userName: maskName(e.userName),
      resumeScore: e.resumeScore,
      jobTitle: e.jobTitle,
      analyzedAt: e.analyzedAt,
    }));

    res.json({ success: true, entries: ranked });
  } catch (err) {
    console.error("[Leaderboard] Resume ranking error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/leaderboard/interview/:category
router.get("/interview/:category", async (req, res) => {
  try {
    const entries = await InterviewRanking.find({ category: req.params.category })
      .sort({ interviewScore: -1 })
      .limit(100)
      .lean();

    const ranked = entries.map((e, i) => ({
      rank: i + 1,
      userName: maskName(e.userName),
      interviewScore: e.interviewScore,
      jobTitle: e.jobTitle,
      interviewType: e.interviewType,
      difficulty: e.difficulty,
      completedAt: e.completedAt,
    }));

    res.json({ success: true, entries: ranked });
  } catch (err) {
    console.error("[Leaderboard] Interview ranking error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/leaderboard/me
router.get("/me", clerkAuth, async (req, res) => {
  try {
    const Profile = mongoose.model("Profile");
    const profile = await Profile.findOne({ clerkId: req.auth.userId });
    if (!profile) return res.json({ success: true, rankings: [] });

    const userId = profile._id;

    const [resumeRankings, interviewRankings] = await Promise.all([
      ResumeRanking.find({ userId }).lean(),
      InterviewRanking.find({ userId }).lean(),
    ]);

    const allCategories = new Set();
    for (const r of resumeRankings) allCategories.add(r.category);
    for (const r of interviewRankings) allCategories.add(r.category);

    const results = [];

    const categoryTasks = [...allCategories].map(async (category) => {
      const entry = { category, resumeRank: null, resumeScore: null, resumeTotal: null, interviewRank: null, interviewScore: null, interviewTotal: null };

      const rr = resumeRankings.find(r => r.category === category);
      const ir = interviewRankings.find(r => r.category === category);

      const [resumeTotals, resumeHigher, interviewTotals, interviewHigher] = await Promise.all([
        rr ? ResumeRanking.countDocuments({ category }) : Promise.resolve(null),
        rr ? ResumeRanking.countDocuments({ category, resumeScore: { $gt: rr.resumeScore } }) : Promise.resolve(null),
        ir ? InterviewRanking.countDocuments({ category }) : Promise.resolve(null),
        ir ? InterviewRanking.countDocuments({ category, interviewScore: { $gt: ir.interviewScore } }) : Promise.resolve(null),
      ]);

      if (rr) {
        entry.resumeRank = (resumeHigher || 0) + 1;
        entry.resumeScore = rr.resumeScore;
        entry.resumeTotal = resumeTotals;
      }

      if (ir) {
        entry.interviewRank = (interviewHigher || 0) + 1;
        entry.interviewScore = ir.interviewScore;
        entry.interviewTotal = interviewTotals;
      }

      return entry;
    });

    results.push(...await Promise.all(categoryTasks));

    res.json({ success: true, rankings: results });
  } catch (err) {
    console.error("[Leaderboard] Me error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
