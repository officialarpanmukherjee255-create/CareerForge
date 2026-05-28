const DEFAULT_SERVER_URL = "http://localhost:5000";
let SERVER_URL = window.__SERVER_URL || DEFAULT_SERVER_URL;

async function resolveServerUrl() {
  if (typeof window.__resolveServerUrl === "function") {
    try {
      SERVER_URL = await window.__resolveServerUrl();
    } catch (err) {
      console.error("[Profile] Failed to resolve backend URL:", err?.message || err);
    }
  }
  return SERVER_URL;
}

function formatPlanLabel(plan) {
  return (plan || "free").charAt(0).toUpperCase() + (plan || "free").slice(1);
}

function featureLabel(featureKey) {
  const labels = {
    resumeAnalysis: "Resume Analysis",
    jobFitResume: "Job Fit Resume",
    interviewPrep: "Interview Prep",
    coverLetter: "Cover Letter",
  };
  return labels[featureKey] || featureKey;
}

function renderPlanDashboard(profile, usageData) {
  const plan = usageData?.plan || profile.plan || "free";
  const usageCounters = usageData?.usageCounters || profile.usageCounters || {};
  const limits = usageData?.limits || {};

  document.getElementById("pfPlanPill").textContent = formatPlanLabel(plan);

  const noteParts = [];
  noteParts.push(usageData?.hasChosenPlan ? "Plan selected" : "Default plan");
  if (plan === "free") noteParts.push("Free tier active");
  document.getElementById("pfPlanNote").textContent = noteParts.join(" • ");

  const selectedAt = usageData?.planSelectedAt || profile.planSelectedAt;
  document.getElementById("pfPlanSelectedAt").textContent = selectedAt
    ? `Selected on ${new Date(selectedAt).toLocaleString()}`
    : "No plan selection recorded yet.";

  const order = ["resumeAnalysis", "jobFitResume", "interviewPrep", "coverLetter"];
  const usageGrid = document.getElementById("pfUsageGrid");
  usageGrid.innerHTML = order.map((key) => {
    const item = usageCounters[key] || { count: 0 };
    const limit = limits[key];
    const safeLimit = limit === Infinity ? null : Number(limit || 0);
    const count = Number(item.count || 0);
    const pct = safeLimit ? Math.min((count / safeLimit) * 100, 100) : 100;
    return `
      <div class="pf-usage-item">
        <div class="pf-usage-top">
          <span>${featureLabel(key)}</span>
          <span>${count}/${safeLimit === null ? "∞" : safeLimit}</span>
        </div>
        <div class="pf-usage-track"><div class="pf-usage-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join("");
}

async function refreshPlanDashboard(profile) {
  try {
    const usage = await window.__loadPlanUsage?.();
    renderPlanDashboard(profile, usage || null);
  } catch (err) {
    console.warn("[Profile] Plan usage load failed:", err.message);
    renderPlanDashboard(profile, null);
  }
}

async function loadProfile() {
  console.log("[Profile] init start");
  let rendered = false;
  const baseUrl = await resolveServerUrl();
  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) {
    console.warn("[Profile] No auth token found");
    document.getElementById("pfName").textContent = "Please sign in";
    document.getElementById("pfEmail").textContent = "Sign in to view your profile";
    console.log("[Profile] loading state resolved: signed out");
    return;
  }

  try {
    console.log("[Profile] Fetching profile...");
    const resp = await fetch(`${baseUrl}/api/profile`, { headers });
    if (!resp.ok) {
      console.error(`[Profile] GET /api/profile failed: ${resp.status} ${resp.statusText}`);
    }
    const data = await resp.json();
    console.log("[Profile] GET response:", data);

    if (data.success && data.profile) {
      renderProfile(data.profile);
      rendered = true;
    } else {
      console.log("[Profile] No profile found, creating one...");
      const user = window.__getClerkUser();
      console.log("[Profile] Clerk user data:", user);
      if (user) {
        const createResp = await fetch(`${baseUrl}/api/profile`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            email: user.email,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
          }),
        });
        if (!createResp.ok) {
          console.error(`[Profile] POST /api/profile failed: ${createResp.status} ${createResp.statusText}`);
        }
        const createData = await createResp.json();
        console.log("[Profile] POST response:", createData);
        if (createData.success) {
          renderProfile(createData.profile);
          rendered = true;
        } else {
          document.getElementById("pfName").textContent = "Error creating profile";
          document.getElementById("pfEmail").textContent = createData.error || "Unknown error";
        }
      } else {
        console.warn("[Profile] No Clerk user data available");
        document.getElementById("pfName").textContent = "Not signed in";
      }
    }
  } catch (err) {
    console.error("[Profile] Load error:", err);
    document.getElementById("pfName").textContent = "Error loading profile";
    document.getElementById("pfEmail").textContent = err.message;
  } finally {
    const currentName = document.getElementById("pfName").textContent;
    console.log("[Profile] loading state resolved:", { rendered, currentName });
    if (document.getElementById("pfPlanPill").textContent === "Loading...") {
      document.getElementById("pfPlanPill").textContent = "Unknown";
    }
    if (document.getElementById("pfPlanNote").textContent === "Loading your current plan and usage.") {
      document.getElementById("pfPlanNote").textContent = "Plan data unavailable right now.";
    }
  }
}

function renderProfile(profile) {
  document.getElementById("pfName").textContent = profile.firstName
    ? `${profile.firstName} ${profile.lastName}`.trim()
    : profile.username || "User";
  document.getElementById("pfEmail").textContent = profile.email || "";
  document.getElementById("pfUsername").textContent = profile.username || "—";
  document.getElementById("pfEmailDetail").textContent = profile.email || "—";
  document.getElementById("pfRole").textContent = profile.role || "user";

  const avatar = document.getElementById("pfAvatar");
  const user = window.__getClerkUser();
  if (user?.imageUrl) {
    avatar.innerHTML = `<img src="${user.imageUrl}" alt="Avatar" />`;
  } else {
    const initial = (profile.firstName || profile.username || "U")[0].toUpperCase();
    avatar.innerHTML = `<span class="pf-avatar-fallback">${initial}</span>`;
  }

  if (profile.role === "admin") {
    const badge = document.getElementById("pfRoleBadge");
    badge.textContent = "Admin";
    badge.style.display = "inline-block";
  }

  document.getElementById("pfResumeCount").textContent = profile.resumes && profile.resumes.length > 0 ? `(${profile.resumes.length})` : "";
  renderResumeList(profile.resumes || []);
  refreshPlanDashboard(profile);
}

function renderResumeList(resumes) {
  const list = document.getElementById("pfResumeList");
  if (resumes.length === 0) {
    list.innerHTML = '<p class="pf-empty">No saved resumes yet.</p>';
    return;
  }
  list.innerHTML = resumes.map(r => `
    <div class="pf-resume-item">
      <div class="pf-resume-info">
        <span class="pf-resume-title">${escHtml(r.title)}</span>
        <span class="pf-resume-date">${new Date(r.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="pf-resume-actions">
        ${r.viewUrl ? `<button class="pf-resume-dl pf-view-btn" data-id="${r._id}">View</button>` : ""}
        ${r.downloadUrl ? `<button class="pf-resume-dl pf-dl-btn" data-id="${r._id}">Download</button>` : ""}
        <button class="pf-resume-del" data-id="${r._id}">Delete</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".pf-resume-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this resume?")) return;
      const headers = await window.__getAuthHeaders();
      if (!headers.Authorization) return;
      const baseUrl = await resolveServerUrl();
      const delResp = await fetch(`${baseUrl}/api/profile/resumes/${btn.dataset.id}`, {
        method: "DELETE",
        headers,
      });
      if (!delResp.ok) {
        console.error(`[Profile] DELETE resume failed: ${delResp.status} ${delResp.statusText}`);
      }
      const profileResp = await fetch(`${baseUrl}/api/profile`, { headers });
      const data = await profileResp.json();
      if (data.success && data.profile) {
        renderResumeList(data.profile.resumes || []);
        document.getElementById("pfResumeCount").textContent = data.profile.resumes.length > 0 ? `(${data.profile.resumes.length})` : "";
      }
    });
  });
  list.querySelectorAll(".pf-view-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const headers = await window.__getAuthHeaders();
      if (!headers.Authorization) return;
      const baseUrl = await resolveServerUrl();
      const resp = await fetch(`${baseUrl}/api/profile/resumes/${btn.dataset.id}/pdf?dl=0`, { headers });
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    });
  });
  list.querySelectorAll(".pf-dl-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const headers = await window.__getAuthHeaders();
      if (!headers.Authorization) return;
      const baseUrl = await resolveServerUrl();
      const resp = await fetch(`${baseUrl}/api/profile/resumes/${btn.dataset.id}/pdf?dl=1`, { headers });
      if (!resp.ok) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const titleEl = btn.closest(".pf-resume-item")?.querySelector(".pf-resume-title");
      a.download = (titleEl?.textContent || "resume") + ".pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  });
}

function escHtml(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ── Resume Upload ──
document.getElementById("pfChooseBtn").addEventListener("click", () => {
  document.getElementById("pfResumeFile").click();
});

document.getElementById("pfResumeFile").addEventListener("change", (e) => {
  const file = e.target.files[0];
  document.getElementById("pfFileName").textContent = file ? file.name : "No file chosen";
  document.getElementById("pfUploadBtn").disabled = !file;
});

document.getElementById("pfUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("pfResumeFile");
  const titleInput = document.getElementById("pfResumeTitle");
  const status = document.getElementById("pfUploadStatus");
  const file = fileInput.files[0];
  const title = titleInput.value.trim() || file.name.replace(/\.pdf$/i, "");

  if (!file) return;

  const headers = await window.__getAuthHeaders();
  if (!headers.Authorization) {
    status.textContent = "Please sign in first";
    return;
  }

  status.textContent = "Uploading...";
  const btn = document.getElementById("pfUploadBtn");
  btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", title);

    const baseUrl = await resolveServerUrl();
    const resp = await fetch(`${baseUrl}/api/profile/resumes/upload`, {
      method: "POST",
      headers: { Authorization: headers.Authorization },
      body: formData,
    });
    if (!resp.ok) {
      console.error(`[Profile] Upload resume failed: ${resp.status} ${resp.statusText}`);
    }
    const data = await resp.json();

    if (data.success) {
      status.textContent = "Uploaded successfully!";
      titleInput.value = "";
      fileInput.value = "";
      document.getElementById("pfFileName").textContent = "No file chosen";
      btn.disabled = true;
      const profileResp = await fetch(`${baseUrl}/api/profile`, {
        headers: { Authorization: headers.Authorization },
      });
      const profileData = await profileResp.json();
      if (profileData.success && profileData.profile) {
        renderResumeList(profileData.profile.resumes || []);
        document.getElementById("pfResumeCount").textContent = profileData.profile.resumes.length > 0 ? `(${profileData.profile.resumes.length})` : "";
      }
    } else {
      status.textContent = "Upload failed: " + (data.error || "Unknown error");
    }
  } catch (err) {
    status.textContent = "Upload error: " + err.message;
  }

  btn.disabled = false;
});

(async function init() {
  await window.__clerkReady;
  await loadProfile();
})();

document.getElementById("pfOpenPlanModalBtn")?.addEventListener("click", async () => {
  await window.__openPlanSelectionModal?.({ reason: "dashboard" });
});

document.getElementById("pfRefreshPlanBtn")?.addEventListener("click", async () => {
  await loadProfile();
});

window.__refreshPlanDashboard = async () => {
  await loadProfile();
};
