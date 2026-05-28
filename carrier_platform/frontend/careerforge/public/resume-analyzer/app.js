import * as pdfjsLib from "/resume-analyzer/libs/pdf.mjs";

const DEFAULT_SERVER_URL = "http://localhost:5000";
let SERVER_URL = window.__SERVER_URL || DEFAULT_SERVER_URL;

console.log("[Resume Analyzer] init started");

async function resolveServerUrl() {
  if (typeof window.__resolveServerUrl === "function") {
    try {
      SERVER_URL = await window.__resolveServerUrl();
    } catch (err) {
      console.error("[Resume Analyzer] Failed to resolve backend URL:", err?.message || err);
    }
  }
  return SERVER_URL;
}

pdfjsLib.GlobalWorkerOptions.workerSrc = "/resume-analyzer/libs/pdf.worker.mjs";
window.__pdfjsLib = pdfjsLib;

var jobdesc = document.getElementById("jobd");
var jobttl = document.getElementById("jobttl");
var pdf = document.getElementById("pdf");
var btn = document.getElementById("tlr");
var savedResumeSelect = document.getElementById("savedResumeSelect");
var savedResumeStatus = document.getElementById("savedResumeStatus");
var savedResumeHint = document.getElementById("savedResumeHint");
var pdfSourceStatus = document.getElementById("pdfSourceStatus");

let loaderTimer = null;
let lastResumeText = "";
let lastJobTitle = "";
let lastJobDesc = "";
let lastPdfData = null;
let lastTailoredText = "";
let activeResumeSource = "";
let activeResumeBlob = null;

function escHtml(s) {
  if (!s) return "";
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function lineDiff(original, tailored) {
  var oLines = (original || "").split("\n");
  var tLines = (tailored || "").split("\n");
  var html = "";
  var oIdx = 0, tIdx = 0;
  while (oIdx < oLines.length || tIdx < tLines.length) {
    var oLine = oLines[oIdx] || "";
    var tLine = tLines[tIdx] || "";
    if (oLine === tLine) {
      html += '<div style="color:#94a3b8;padding:2px 16px;white-space:pre-wrap;word-break:break-word;">' + escHtml(oLine) + "</div>";
      oIdx++; tIdx++;
    } else {
      var found = false;
      for (var look = 1; look <= 3; look++) {
        if (oIdx + look < oLines.length && oLines[oIdx + look] === tLine) {
          for (var k = 0; k < look; k++) {
            html += '<div style="color:#ef4444;background:rgba(239,68,68,0.08);padding:2px 16px;border-left:2px solid #ef4444;white-space:pre-wrap;word-break:break-word;">-' + escHtml(oLines[oIdx + k]) + "</div>";
          }
          html += '<div style="color:#94a3b8;padding:2px 16px;white-space:pre-wrap;word-break:break-word;">' + escHtml(tLine) + "</div>";
          oIdx += look + 1; tIdx++;
          found = true; break;
        }
        if (tIdx + look < tLines.length && tLines[tIdx + look] === oLine) {
          for (var k2 = 0; k2 < look; k2++) {
            html += '<div style="color:#34d399;background:rgba(52,211,153,0.08);padding:2px 16px;border-left:2px solid #34d399;white-space:pre-wrap;word-break:break-word;">+' + escHtml(tLines[tIdx + k2]) + "</div>";
          }
          html += '<div style="color:#94a3b8;padding:2px 16px;white-space:pre-wrap;word-break:break-word;">' + escHtml(oLine) + "</div>";
          oIdx++; tIdx += look + 1;
          found = true; break;
        }
      }
      if (!found) {
        html += '<div style="color:#ef4444;background:rgba(239,68,68,0.08);padding:2px 16px;border-left:2px solid #ef4444;white-space:pre-wrap;word-break:break-word;">-' + escHtml(oLine) + "</div>";
        html += '<div style="color:#34d399;background:rgba(52,211,153,0.08);padding:2px 16px;border-left:2px solid #34d399;white-space:pre-wrap;word-break:break-word;">+' + escHtml(tLine) + "</div>";
        oIdx++; tIdx++;
      }
    }
  }
  return html;
}

function stopLoaderCycle() {
  clearTimeout(loaderTimer);
  document
    .querySelectorAll(".status-steps li")
    .forEach((li) => li.classList.remove("is-visible"));
}
function startLoaderCycle(onDone) {
  const steps = document.querySelectorAll(".status-steps li");
  let index = 0;

  steps.forEach((li) => li.classList.remove("is-visible"));

  function next() {
    if (index >= steps.length) {
      onDone(); // 🔥 loader fully finished
      return;
    }

    steps[index].classList.add("is-visible");

    setTimeout(() => {
      steps[index].classList.remove("is-visible");
      index++;
      next();
    }, 900);
  }

  next();
}

async function waitForResumeHelpers() {
  for (let i = 0; i < 200; i++) {
    if (window.__getSavedResumes && window.__loadSavedResumePdf && window.__readPdfText) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Resume helpers not ready");
}

async function extractPdfText(source) {
  await waitForResumeHelpers();
  const rawText = await window.__readPdfText(source, { includeLinks: true });
  return rawText
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[•●▪■]/g, "")
    .replace(/(EXPERIENCE|SKILLS|EDUCATION|PROJECTS|SUMMARY)/gi, "\n$1\n");
}

function resetUploadState() {
  pdf.value = "";
  const pdfPreview = document.getElementById("pdfPreview");
  const dropText = document.getElementById("dropText");
  if (pdfPreview) pdfPreview.style.display = "none";
  if (dropText) dropText.textContent = "Click to upload PDF resume";
  if (pdfSourceStatus) pdfSourceStatus.textContent = "Upload a PDF or choose one of your saved resumes.";
  activeResumeSource = "";
}

function showUploadState(label) {
  const pdfName = document.getElementById("pdfName");
  const pdfChars = document.getElementById("pdfChars");
  const pdfPreview = document.getElementById("pdfPreview");
  const dropText = document.getElementById("dropText");
  if (pdfName) pdfName.textContent = label;
  if (pdfChars) pdfChars.textContent = `(${lastResumeText.length.toLocaleString()} chars)`;
  if (pdfPreview) pdfPreview.style.display = "flex";
  if (dropText) dropText.textContent = "Resume uploaded ✓";
  if (savedResumeSelect && savedResumeSelect.value) savedResumeSelect.value = "";
  if (savedResumeStatus) savedResumeStatus.textContent = "Pick a saved resume to use it instead of the uploaded file.";
  if (savedResumeHint) savedResumeHint.textContent = "Read-only selection. Nothing is written back to your Profile.";
  if (pdfSourceStatus) pdfSourceStatus.textContent = `Using ${label}.`;
  activeResumeSource = "upload";
}

async function loadSavedResumes() {
  console.log("[Resume Analyzer] loading saved resumes");
  try {
    await waitForResumeHelpers();
    const resumes = await window.__getSavedResumes();
    savedResumeSelect.innerHTML = "";

    if (!resumes.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No saved resumes yet";
      savedResumeSelect.appendChild(option);
      savedResumeSelect.disabled = true;
      savedResumeStatus.textContent = "No saved resumes yet.";
      savedResumeHint.textContent = "Go to your Profile to save a resume, then return here.";
      return [];
    }

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a saved resume";
    savedResumeSelect.appendChild(placeholder);

    resumes.forEach((resume) => {
      const option = document.createElement("option");
      option.value = resume._id;
      option.textContent = resume.title || "Untitled Resume";
      savedResumeSelect.appendChild(option);
    });

    savedResumeSelect.disabled = false;
    savedResumeStatus.textContent = "Pick one of your saved resumes.";
    savedResumeHint.textContent = "Read-only selection. Nothing is written back to your Profile.";
    console.log("[Resume Analyzer] saved resumes loaded:", resumes.length);
    return resumes;
  } catch (err) {
    console.error("[Resume Analyzer] saved resume load failed:", err?.message || err);
    if (savedResumeStatus) savedResumeStatus.textContent = "Unable to load saved resumes right now.";
    if (savedResumeHint) savedResumeHint.textContent = err?.message || "Unknown error";
    return [];
  }
}

async function useSavedResume(resumeId) {
  if (!resumeId) {
    lastResumeText = "";
    activeResumeSource = "";
    activeResumeBlob = null;
    resetUploadState();
    savedResumeStatus.textContent = savedResumeHint.textContent || "Select a saved resume from your Profile.";
    return;
  }

  await waitForResumeHelpers();
  console.log("[Resume Analyzer] saved resume selected:", resumeId);
  savedResumeStatus.textContent = "Loading saved resume...";
  const resumes = await window.__getSavedResumes();
  const selected = resumes.find((resume) => resume._id === resumeId);
  const blob = await window.__loadSavedResumePdf(resumeId);

  try {
    lastResumeText = await extractPdfText(blob);
    lastJobTitle = jobttl.value;
    lastJobDesc = jobdesc.value;
    activeResumeBlob = blob;
    resetUploadState();
    const savedFile = new File([blob], `${selected?.title || "saved-resume"}.pdf`, { type: "application/pdf" });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(savedFile);
    savedResumeSelect.value = resumeId;
    savedResumeStatus.textContent = `Using ${selected?.title || "the selected saved resume"}.`;
    savedResumeHint.textContent = "Read-only selection. Nothing is written back to your Profile.";
    document.getElementById("pdfSourceStatus").textContent = `Using saved resume: ${selected?.title || "Untitled Resume"}.`;
    activeResumeSource = "saved";
  } catch (err) {
    throw err;
  }
}

btn.onclick = async function () {
  console.log("[Resume Analyzer] analyze button clicked");
  if (!lastResumeText && !pdf.files?.[0] && !activeResumeBlob) {
    alert("please upload a file or choose a saved resume");
    return;
  }

  // If we have a file/blob but no text yet, extract it now
  if (!lastResumeText) {
    const file = activeResumeBlob || pdf.files?.[0];
    if (file) {
      try {
        lastResumeText = await extractPdfText(file);
      } catch {
        alert("Could not read the resume file. Try uploading again.");
        return;
      }
    }
  }

  document.querySelector(".aipnl").style.display = "block";

  startLoaderCycle(async () => {
    document.querySelector(".aipnl").style.display = "none";

    const cleanText = lastResumeText;
    lastJobTitle = jobttl.value;
    lastJobDesc = jobdesc.value;

    const jobprompt = `
                                        You are "ResumeTailor_Architect_v4_Industrial", a specialized, ruthless, logic-driven ATS (Applicant Tracking System) Engine.

                    YOUR ROLE:
                    You are NOT a career coach. You are NOT a resume writer. You are a precision-focused Hiring Algorithm.
                    Your job is to disqualify unqualified candidates and identify genuine gaps.
                    You do NOT give the benefit of the doubt. You rely ONLY on explicit text evidence.

                    ================================================================================
                    SECTION 1: THE "MUTUALLY EXCLUSIVE" (OR) LOGIC PROTOCOL
                    ================================================================================

                    Job Descriptions (JDs) often list alternatives. You must identify them immediately to avoid "False Positives" in the missing list.

                    PROTOCOL:
                    1. Scan the JD for "OR" separators (e.g., "Java, Python, OR C++", "AWS, Azure, or GCP").
                    2. Check the Resume for ANY ONE of these options.

                    SCENARIO A: Candidate has ONE of them.
                    - RESULT: The requirement is MET.
                    - ACTION: Mark that skill as PRESENT.
                    - CRITICAL: Do NOT list the other unused options as "Missing". They are irrelevant.

                    SCENARIO B: Candidate has NONE of them.
                    - RESULT: The requirement is MISSING.
                    - ACTION: Create ONE single missing entry named after the group.
                    - Example Name: "Cloud Provider (AWS/Azure/GCP)" or "Backend Language (Java/Python)".
                    - CRITICAL: Do NOT list "AWS", "Azure", and "GCP" as 3 separate missing skills. This inflates the error count falsely.

                    ================================================================================
                    SECTION 2: FOUNDATIONAL OPERATING RULES
                    ================================================================================

                    1. SINGLE SOURCE OF TRUTH:
                    - The Resume Text provided is the ONLY representation of the candidate.
                    - If a skill is not written, it does not exist (unless strictly implied by a composite stack).

                    2. STRICT INTERPRETATION OF JD:
                    - "Required", "Must have", "Proficiency in" = HARD REQUIREMENT (High/Medium Priority).
                    - "Preferred", "Bonus", "Plus", "Good to have" = PREFERRED (Low Priority).
                    - Preferred skills MUST NEVER appear in the "missing" list. They go to "preferredExposureGaps".

                    3. COMPOSITE STACK LOGIC:
                    - MERN = Mongo + Express + React + Node.
                    - LAMP = Linux + Apache + MySQL + PHP.
                    - RULE: If a candidate lists the *Components*, they have the *Stack*.
                    - ACTION: Do not mark "MERN Stack" as missing if components are present. Move to "keywordOptimization".

                    ================================================================================
                    SECTION 3: STEP-BY-STEP EXECUTION PIPELINE
                    ================================================================================

                    You must process the input in this exact order.

                    ### PHASE 1: EDUCATION & ELIGIBILITY (THE GATEKEEPER)
                    1. Extract JD Degree Requirements (BS, MS, PhD) and Field (CS, EE, etc.).
                    2. Extract Resume Degree and Major.
                    3. Compare:
                    - MATCH: Resume Degree >= JD Degree AND Field matches.
                    - PARTIAL: Resume Degree == JD Degree but Field differs.
                    - MISMATCH: Resume Degree < JD Degree OR Resume has NO degree.
                    4. "Equivalent Experience" Clause:
                    - Only downgrade "Mismatch" to "Partial" if the JD EXPLICITLY says "or equivalent experience".

                    ### PHASE 2: HARD SKILLS EXTRACTION
                    1. Extract keywords.
                    2. Filter out "Preferred" skills (send to Phase 4).
                    3. Check Resume for Exact or Implied matches.
                    4. Apply "OR" Logic (Section 1).
                    5. Generate "Missing" list.

                    ### PHASE 3: ATS KEYWORD OPTIMIZATION
                    1. Detect skills that are PRESENT/IMPLIED but use different wording.
                    - Example: JD wants "CI/CD", Resume has "Jenkins".
                    - Example: JD wants "TDD", Resume has "Unit Testing with Jest".
                    2. These are NOT missing skills. Report in keywordOptimization.

                    ### PHASE 4: PREFERRED SKILLS ANALYSIS
                    1. Check skills listed as "Bonus/Preferred" in JD.
                    2. If absent, add to preferredExposureGaps.
                    3. These do NOT affect the score negatively.

                    ================================================================================
                    SECTION 4: THE SUBTRACTIVE SCORING ALGORITHM (STABILITY ENGINE)
                    ================================================================================

                    You must calculate the overallScore using this exact mathematical formula.
                    START WITH: 100 POINTS.

                    APPLY DEDUCTIONS:

                    1. **Hard Skills Gaps (The Heavy Hitters):**
                    - For every MISSING "High Priority" skill/group: **SUBTRACT 12 POINTS**.
                    - For every MISSING "Medium Priority" skill/group: **SUBTRACT 6 POINTS**.
                    - For every MISSING "Low Priority" skill/group: **SUBTRACT 3 POINTS**.

                    2. **Education Gaps:**
                    - If status is "Mismatch": **SUBTRACT 20 POINTS**.
                    - If status is "Partial": **SUBTRACT 5 POINTS**.

                    3. **Experience Gaps:**
                    - If Years of Experience < 50% of required: **SUBTRACT 15 POINTS**.
                    - If Domain is irrelevant (e.g. Sales resume for Coding job): **SUBTRACT 10 POINTS**.

                    4. **Formatting/Keyword Gaps:**
                    - For every "Keyword Optimization Opportunity": **SUBTRACT 1 POINT**.

                    APPLY MANDATORY "KILL SWITCH" CAPS (OVERRIDES):
                    After calculation, check these conditions. If met, FORCE the score down.

                    1. **THE "CORE TECH" CAP:**
                    - If the JD requires a Core Language/Framework (e.g., Java, React) and it is MISSING:
                    - **MAX SCORE ALLOWED: 55**. (Even if everything else is perfect).

                    2. **THE "MULTIPLE GAPS" CAP:**
                    - If > 2 High Priority Skills are MISSING:
                    - **MAX SCORE ALLOWED: 60**.

                    3. **THE "EDUCATION" CAP:**
                    - If Education is "Mismatch" (and no experience clause):
                    - **MAX SCORE ALLOWED: 70**.

                    *Example Calculation:*
                    Start 100.
                    Missing "Java" (High, Core) -> -12.
                    Missing "Spring" (High) -> -12.
                    Missing "Microservices" (Medium) -> -6.
                    Calculated Score: 70.
                    "Core Tech Cap" triggered (Missing Java): Force Score -> 55.
                    Final Score: 55.

                    ================================================================================
                    SECTION 5: OUTPUT JSON ARCHITECTURE (STRICT)
                    ================================================================================

                    You must output PURE JSON. No markdown fencing.
                    The JSON keys must match the following schema EXACTLY.

                    {
                    "overallScore": integer (Calculated via Subtractive Model),
                    "verdict": string ("Perfect Match" | "Strong Candidate" | "Good Potential" | "Needs Work" | "Not a Fit"),
                    "categoryScores": {
                        "hardSkills": integer (0-100),
                        "experience": integer (0-100),
                        "softSkills": integer (0-100),
                        "atsAlignment": integer (0-100)
                    },
                    "hardSkillsAnalysis": {
                        "present": [ "Array of strings: Skills found exactly" ],
                        "implied": [ "Array of strings: Skills inferred (e.g. Git implied by GitHub)" ],
                        "missing": [
                        {
                            "skill": "Name of missing skill (or Group Name if 'OR' logic)",
                            "importance": "High" | "Medium" | "Low",
                            "estimatedLearningTime": "e.g. 2-3 weeks",
                            "reason": "Why is this required?"
                        }
                        ],
                        "preferredExposureGaps": [
                        {
                            "skill": "Name of preferred skill",
                            "estimatedLearningTime": "e.g. 1 week",
                            "reason": "Listed as 'Nice to have' in JD"
                        }
                        ],
                        "keywordOptimization": [
                        {
                            "keyword": "Exact keyword from JD",
                            "reason": "Resume has the skill but uses different wording",
                            "whereToAdd": "e.g. 'Skills Section' or 'Summary'"
                        }
                        ]
                    },
                    "keywordOptimizationOpportunities": [ "Array of summary strings for keyword fixes" ],
                    "softSkillGaps": [ "Array of strings: Soft skills required by JD but not signaled" ],
                    "educationFit": {
                        "status": "Match" | "Partial" | "Mismatch",
                        "details": "Specific explanation of degree/major comparison"
                    },
                    "experienceFitSummary": "2-3 sentences analyzing seniority and relevance",
                    "recommendations": [
                        "Array of strings: Concrete, actionable advice.",
                        "MUST link directly to a missing skill or keyword.",
                        "Do not give generic advice."
                    ]
                    }

                    ================================================================================
                    SECTION 6: FINAL SANITY CHECK
                    ================================================================================

                    Before printing JSON:
                    1. Did you list "AWS", "Azure", and "GCP" as 3 separate missing items? If yes, CONSOLIDATE them into one.
                    2. Is the score > 80 but "Core Tech" is missing? If yes, LOWER the score to 55.
                    3. Are preferred skills in the "missing" list? If yes, MOVE them to "preferredExposureGaps".

                    ================================================================================
                    INPUT DATA
                    ================================================================================

                    RESUME TEXT:
                    [RESUME TEXT]

                    JOB DESCRIPTION:
                    [JOB DESCRIPTION]

                    JOB TITLE:
                    [JOB TITLE]

                    PERFORM ANALYSIS. GENERATE ONLY JSON.





                                    `;

        let prompt = jobprompt
          .replace("[RESUME TEXT]", cleanText)
          .replace("[JOB DESCRIPTION]", jobdesc.value)
          .replace("[JOB TITLE]", jobttl.value);

        try {
          const baseUrl = await resolveServerUrl();
          const response = await fetch(
            `${baseUrl}/analyze-resume`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(await window.__getAuthHeaders()),
              },
              body: JSON.stringify({
                prompt: prompt,
                jobTitle: lastJobTitle,
                jobDescription: lastJobDesc,
                resumeText: cleanText,
              }),
            },
          );
          if (!response.ok) {
            console.error(`[Resume Analyzer] analyze-resume failed: ${response.status} ${response.statusText}`);
          }

          if (window.__handlePlanLimitResponse && await window.__handlePlanLimitResponse(response, "Resume Analysis", "resumeAnalysis")) {
            return;
          }

          const data = await response.json();
          const analysis = data.analysis;
          console.log("PARSED ANALYSIS:", analysis);

          /* ===============================
                    1. OPEN OVERLAY
                    ================================ */
          const overlay = document.querySelector(".ai-review-overlay");
          overlay.classList.add("active");

          /* ===============================
                    2. SCORE RING + VERDICT
                    ================================ */
          const scoreNumber = document.querySelector(
            ".score-ring-value .number",
          );
          const scoreVerdict = document.querySelector(".score-verdict");
          const scoreCircle = document.querySelector(".score-ring-progress");

          scoreNumber.textContent = analysis.overallScore;
          scoreVerdict.textContent = analysis.verdict;

          // SVG progress ring
          const radius = 60;
          const circumference = 2 * Math.PI * radius;
          const offset =
            circumference - (analysis.overallScore / 100) * circumference;

          scoreCircle.style.strokeDasharray = `${circumference}`;
          scoreCircle.style.strokeDashoffset = offset;

          /* ===============================
                    3. CATEGORY BREAKDOWN
                    ================================ */
          const categoryMap = {
            ats: analysis.categoryScores.atsAlignment,
            "hard-skills": analysis.categoryScores.hardSkills,
            "soft-skills": analysis.categoryScores.softSkills,
            experience: analysis.categoryScores.experience,
          };

          Object.entries(categoryMap).forEach(([cls, value]) => {
            const bar = document.querySelector(`.category-bar-fill.${cls}`);
            const label = bar
              .closest(".category-item")
              .querySelector(".category-score");

            bar.style.width = `${value}%`;
            label.textContent = `${value} / 100`;
          });
          // ==============================
          // Preferred Skills (Optional) - MATCHING CSS STYLE
          // ==============================

          const preferredSection = document.getElementById(
            "preferred-skills-section",
          );
          const preferredContainer = document.getElementById(
            "preferred-skills-container",
          );

          // Clear previous results
          preferredContainer.innerHTML = "";

          // 1. Get the data
          const preferredGaps =
            analysis.hardSkillsAnalysis?.preferredExposureGaps;

          // 2. Check if data exists
          if (
            preferredGaps &&
            Array.isArray(preferredGaps) &&
            preferredGaps.length > 0
          ) {
            // Show the section
            preferredSection.style.display = "block";

            // Create cards
            preferredGaps.forEach((item) => {
              const card = document.createElement("div");

              // CHANGE 1: Use 'skill-card' to match Missing Skills styling exactly
              card.className = "skill-card";

              // CHANGE 2: Use the same internal structure (skill-meta, skill-importance)
              card.innerHTML = `
                                <h5>${item.skill}</h5>
                                <div class="skill-meta">
                                    <span class="skill-importance medium">
                                        ● Preferred
                                    </span>
                                    <span class="skill-time">
                                        ⏱ ${item.estimatedLearningTime}
                                    </span>
                                    <span class="skill-time" style="opacity: 0.7;">
                                        ℹ️ ${item.reason}
                                    </span>
                                </div>
                            `;

              preferredContainer.appendChild(card);
            });
          }

          const missingSkills = analysis.hardSkillsAnalysis?.missing || [];
          const skillsGrid = document.querySelector(".skills-grid");
          skillsGrid.innerHTML = "";

          missingSkills.forEach((skill) => {
            const card = document.createElement("div");
            card.className = "skill-card";

            card.innerHTML = `
                        <h5>${skill.skill}</h5>
                        <div class="skill-meta">
                        <span class="skill-importance ${String(skill.importance || "low").toLowerCase()}">
                            ● ${skill.importance || "Low"} Priority
                        </span>
                        <span class="skill-time">
                            ⏱ ${skill.estimatedLearningTime || "1 week"}
                        </span>
                        </div>
                    `;

            skillsGrid.appendChild(card);
          });

          const softSkillsList = document.querySelector(".soft-skills-list");
          softSkillsList.innerHTML = "";

          (analysis.softSkillGaps || []).forEach((skill) => {
            const item = document.createElement("div");
            item.className = "soft-skill-item";

            item.innerHTML = `
                        <div class="soft-skill-icon">💡</div>
                        <span>${skill}</span>
                    `;

            softSkillsList.appendChild(item);
          });

          const suggestionsList = document.querySelector(".suggestions-list");
          suggestionsList.innerHTML = "";

          (analysis.hardSkillsAnalysis?.keywordOptimization || []).forEach((k) => {
            const item = document.createElement("div");
            item.className = "suggestion-item";

            item.innerHTML = `
                        <div class="suggestion-checkbox"></div>
                        <span>
                        ATS wording fix: add "<strong>${k.keyword}</strong>" in 
                        <em>${k.whereToAdd}</em> — ${k.reason}
                        </span>
                    `;

            suggestionsList.appendChild(item);
          });

          (analysis.recommendations || []).forEach((text) => {
            const item = document.createElement("div");
            item.className = "suggestion-item";

            item.innerHTML = `
                        <div class="suggestion-checkbox"></div>
                        <span>${typeof text === "string" ? text : text.text}</span>
                    `;

            suggestionsList.appendChild(item);
          });

          const pdfIframe = document.querySelector(
            ".overlay-resume-preview iframe",
          );
          const previewBlob = activeResumeBlob || pdf.files?.[0] || null;
          const pdfURL = previewBlob ? URL.createObjectURL(previewBlob) : "about:blank";
          pdfIframe.src = pdfURL;

          document.querySelector(".overlay-close").onclick = () => {
            overlay.classList.remove("active");
            if (previewBlob) URL.revokeObjectURL(pdfURL);
          };

          document.getElementById("generateJobResumeBtn").onclick = async () => {
            const genBtn = document.getElementById("generateJobResumeBtn");
            genBtn.disabled = true;
            genBtn.textContent = "Generating...";

            const trResult = document.getElementById("trResult");
            trResult.style.display = "none";

            try {
              const authHeaders = window.__getAuthHeaders ? await window.__getAuthHeaders() : {};
              const baseUrl = await resolveServerUrl();
              const resp = await fetch(`${baseUrl}/generate-job-specific-resume`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders },
                body: JSON.stringify({
                  resumeText: lastResumeText,
                  jobDescription: lastJobDesc,
                  jobTitle: lastJobTitle,
                }),
              });
              if (!resp.ok) {
                console.error(`[Resume Analyzer] generate-job-specific-resume failed: ${resp.status} ${resp.statusText}`);
              }

              if (window.__handlePlanLimitResponse && await window.__handlePlanLimitResponse(resp, "Job Fit Resume", "jobFitResume")) {
                genBtn.disabled = false;
                genBtn.textContent = "Generate Job Specific Resume";
                trResult.style.display = "none";
                return;
              }

              const data = await resp.json();
              if (!data.success) throw new Error(data.error);

              lastPdfData = data.pdf;
              lastTailoredText = data.tailoredText || "";

              var changesHtml = "";
              if (data.changes && data.changes.length) {
                var items = data.changes.map(function(c) {
                  return '<div style="display:flex;gap:10px;padding:8px 12px;border-radius:8px;background:rgba(148,163,184,0.04);border:1px solid rgba(148,163,184,0.06);margin-bottom:6px;font-size:13px;line-height:1.5;color:#c9d8f0;">' +
                    '<span style="color:#7c3aed;font-weight:700;flex-shrink:0;">~</span>' +
                    '<span>' + escHtml(c) + '</span>' +
                  '</div>';
                });
                document.getElementById("trChangesHeader").textContent = "Changes Made (" + data.changes.length + ")";
                document.getElementById("trDiffContent").innerHTML = items.join("");
              } else {
                document.getElementById("trChangesHeader").textContent = "Changes Made";
                document.getElementById("trDiffContent").innerHTML = '<p style="color:#505d78;font-size:13px;">No changes detected.</p>';
              }
              trResult.style.display = "block";

              trResult.scrollIntoView({ behavior: "smooth", block: "start" });
            } catch (err) {
              alert("Error generating resume: " + err.message);
            }

            genBtn.disabled = false;
            genBtn.textContent = "Generate Job Specific Resume";
          };

          document.getElementById("trOpenPdfBtn").onclick = () => {
            if (!lastPdfData) return;
            var win = window.open();
            if (win) {
              win.document.write('<html><body style="margin:0"><embed src="data:application/pdf;base64,' + lastPdfData + '" width="100%" height="100%" type="application/pdf"></body></html>');
              win.focus();
            } else {
              alert("Allow popups to open the PDF.");
            }
          };

          document.getElementById("trPrintBtn").onclick = () => {
            if (!lastTailoredText) return;
            var win = window.open();
            if (win) {
              win.document.write('<html><head><style>body{font-family:Georgia,serif;padding:40px;line-height:1.8;font-size:12pt;color:#000;white-space:pre-wrap;}</style></head><body>' + escHtml(lastTailoredText).replace(/\n/g, "<br>") + '</body></html>');
              win.document.close();
              win.focus();
              win.print();
            } else {
              alert("Allow popups to print.");
            }
          };
    } catch (err) {
      console.error(err);
    }

    stopLoaderCycle();
    document.querySelector(".aipnl").style.display = "none";

    btn.style.display = "block";
    btn.disabled = false;
  });
};

if (pdf) {
  pdf.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    activeResumeBlob = file;
    pdfSourceStatus.textContent = `Reading ${file.name}...`;
    savedResumeStatus.textContent = "Pick a saved resume to use it instead of the uploaded file.";
    savedResumeHint.textContent = "Read-only selection. Nothing is written back to your Profile.";

    try {
      lastResumeText = await extractPdfText(file);
      const charCount = document.getElementById("pdfChars");
      if (charCount) charCount.textContent = `(${lastResumeText.length.toLocaleString()} chars extracted)`;
      pdfSourceStatus.textContent = `Using uploaded resume: ${file.name}`;
      activeResumeSource = "upload";
    } catch (err) {
      pdfSourceStatus.textContent = "Could not read PDF. Try a different file.";
      lastResumeText = "";
    }
  });
}

if (savedResumeSelect) {
  savedResumeSelect.addEventListener("change", async (e) => {
    try {
      await useSavedResume(e.target.value);
      const file = pdf.files[0];
      if (file) {
        pdfSourceStatus.textContent = `Using saved resume: ${savedResumeSelect.options[savedResumeSelect.selectedIndex]?.textContent || "Untitled Resume"}.`;
      }
    } catch (err) {
      savedResumeStatus.textContent = "Could not load selected resume.";
      alert("Error loading saved resume: " + err.message);
    }
  });
}

window.addEventListener("load", async function () {
  try {
    await loadSavedResumes();
  } catch (err) {
    if (savedResumeStatus) savedResumeStatus.textContent = "Unable to load saved resumes.";
    if (savedResumeHint) savedResumeHint.textContent = err?.message || "Unknown error";
  }
});

// ---------- DEMO JOB DATA ----------
const jobDemoData = {
  1: {
    title: " Mern Stack Developer",
    description: `about the job
Job Post :- Mern Stack Developer
Experience :- 3+ years
Location - Ahmedabad (WFO)


Responsibilities:


Application Development: Develop and maintain web applications using the MERN stack (MongoDB, Express.js, React.js, Node.js).
Front-End & Back-End Integration: Collaborate with front-end and back-end developers to create a seamless and efficient full-stack application.
API Design and Integration: Build and integrate RESTful APIs and third-party services to enhance functionality.
Database Management: Optimize MongoDB databases, handle data storage, schema design, and database queries.
Bug Fixes and Maintenance: Troubleshoot, debug, and fix issues that arise during development and production phases.
User Interface Implementation: Work closely with UI/UX designers to implement responsive and user-friendly interfaces using React.js.
Code Optimization: Ensure that the code is optimized for performance, scalability, and security.
Collaboration: Collaborate with product managers and designers to understand user requirements and deliver the best user experience.
Version Control: Use Git and GitHub for version control, ensuring proper codebase management.
Documentation: Maintain clear and concise documentation for code, APIs, and application workflows.


Technical Skills :


Strong knowledge of JavaScript and modern frameworks (React.js).
Understanding of asynchronous programming, promises, a sync/await.
Experience with unit testing frameworks like Jest or Mocha is a plus.
Good understanding of security practices and application optimization techniques.


Soft Skills:


Strong problem-solving and analytical skills.
Excellent communication skills and the ability to collaborate within a team.
Self-motivated with a passion for learning and staying up to date with new technologies.

`,
  },

  2: {
    title: "java Full Stack Developer",
    description: `Strong proficiency in Java (8 or above) with hands-on experience in building scalable backend applications using Spring Boot, Spring MVC, and RESTful APIs. Solid understanding of React.js and modern JavaScript (ES6+), including Redux, Hooks, and component-based architecture. Experience with HTML5, CSS3, SASS/LESS, and responsive design principles. Familiarity with Node.js and NPM/Yarn for frontend build and dependency management. Proficient in working with Relational Databases (e.g., MySQL, PostgreSQL) and NoSQL Databases (e.g., MongoDB). Experience with JPA/Hibernate for ORM and data persistence.

Roles & Responsibilities Design and develop scalable and secure backend services using Java, Spring Boot, and RESTful APIs. Build responsive and dynamic user interfaces using React.js, JavaScript, HTML, and CSS. Collaborate with UI/UX designers, product managers, and other developers to deliver high-quality features. Integrate frontend and backend components to create seamless full-stack solutions. Write clean, maintainable, and well-documented code following best practices and coding standards. Optimize application performance and troubleshoot issues across the stack. Participate in code reviews, sprint planning, and other Agile ceremonies. Implement unit and integration tests to ensure software reliability and maintainability. Work with DevOps teams to manage CI/CD pipelines, containerization, and cloud deployments. Stay updated with emerging technologies and contribute to continuous improvement initiatives.

Core Skills: Strong proficiency in Java (8 or above) with hands-on experience in building scalable backend applications using Spring Boot, Spring MVC, and RESTful APIs. Solid understanding of React.js and modern JavaScript (ES6+), including Redux, Hooks, and component-based architecture. Experience with HTML5, CSS3, SASS/LESS, and responsive design principles. Familiarity with Node.js and NPM/Yarn for frontend build and dependency management. Database & Persistence: Proficient in working with Relational Databases (e.g., MySQL, PostgreSQL) and NoSQL Databases (e.g., MongoDB). Experience with JPA/Hibernate for ORM and data persistence. DevOps & Tools: Hands-on experience with Git, Maven/Gradle, and CI/CD pipelines (e.g., Jenkins, GitLab CI). Familiarity with Docker and containerized application deployment. Exposure to cloud platforms like AWS, Azure, or GCP is a plus. Testing & Quality: Experience with unit testing frameworks (e.g., JUnit, Mockito) and frontend testing tools (e.g., Jest, React Testing Library). Understanding of code quality, linting, and static code analysis tools. Soft Skills & Collaboration: Ability to work in Agile/Scrum environments with cross-functional teams. Strong problem-solving skills and attention to detail. Excellent communication and documentation abilities.`,
  },
};

function bindDemoButtons() {
  const btn1 = document.getElementById("demoBtn1");
  const btn2 = document.getElementById("demoBtn2");
  if (!btn1 || !btn2) return false;

  btn1.onclick = () => injectDemoData(1);
  btn2.onclick = () => injectDemoData(2);
  return true;
}

if (!bindDemoButtons()) {
  document.addEventListener("DOMContentLoaded", bindDemoButtons);
}

console.log("[Resume Analyzer] listeners attached");

// ---------- INJECT FUNCTION ----------
function injectDemoData(option) {
  console.log("[Resume Analyzer] demo button clicked:", option);
  const jobTitleInput = document.getElementById("jobttl");
  const jobDescInput = document.getElementById("jobd");

  jobTitleInput.value = jobDemoData[option].title;
  jobDescInput.value = jobDemoData[option].description;
  jobTitleInput.dispatchEvent(new Event("input", { bubbles: true }));
  jobDescInput.dispatchEvent(new Event("input", { bubbles: true }));

  // Optional UX polish
  jobTitleInput.focus();
}
