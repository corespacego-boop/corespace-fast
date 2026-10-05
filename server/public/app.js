document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const step1Portal = document.getElementById('step1Portal');
  const step2Academia = document.getElementById('step2Academia');
  const dashboardSection = document.getElementById('dashboardSection');
  
  const portalForm = document.getElementById('portalForm');
  const academiaForm = document.getElementById('academiaForm');
  
  const captchaImg = document.getElementById('captchaImg');
  const btnRefreshCaptcha = document.getElementById('btnRefreshCaptcha');
  
  const authAlertStep1 = document.getElementById('authAlertStep1');
  const authAlertStep2 = document.getElementById('authAlertStep2');
  
  const btnStep1Submit = document.getElementById('btnStep1Submit');
  const step1BtnText = document.getElementById('step1BtnText');
  const btnStep2Submit = document.getElementById('btnStep2Submit');
  const step2BtnText = document.getElementById('step2BtnText');
  const btnSkipAcademia = document.getElementById('btnSkipAcademia');
  
  const academiaEmailText = document.getElementById('academiaEmailText');
  
  const userNav = document.getElementById('userNav');
  const userNameChip = document.getElementById('userNameChip');
  const userAccountType = document.getElementById('userAccountType');
  const btnLogout = document.getElementById('btnLogout');

  let currentCdigest = '';
  let currentSessionToken = '';
  let cachedPortalData = null;
  let dashboardData = null;
  let currentTimetableDay = 'Day 1';

  const API_BASE = window.location.origin;

  // Init Captcha
  loadCaptcha();

  btnRefreshCaptcha.addEventListener('click', loadCaptcha);

  // Tabs Navigation
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) targetTab.classList.add('active');
    });
  });

  // Timetable Day Selector
  const dayBtns = document.querySelectorAll('.day-btn');
  dayBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dayBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTimetableDay = btn.dataset.day;
      renderTimetable();
    });
  });

  // Logout Handler
  btnLogout.addEventListener('click', () => {
    dashboardData = null;
    cachedPortalData = null;
    currentSessionToken = '';
    
    userNav.classList.add('hidden');
    dashboardSection.classList.add('hidden');
    step2Academia.classList.add('hidden');
    step1Portal.classList.remove('hidden');
    
    document.getElementById('portalForm').reset();
    document.getElementById('academiaForm').reset();
    loadCaptcha();
  });

  // Load Captcha
  async function loadCaptcha() {
    try {
      captchaImg.src = '';
      btnRefreshCaptcha.disabled = true;
      const res = await fetch(`${API_BASE}/portal/captcha`, { method: 'POST' });
      const data = await res.json();
      
      if (data.image) {
        captchaImg.src = data.image;
        currentCdigest = data.cdigest || data.session || '';
      }
    } catch (err) {
      showError(authAlertStep1, 'Failed to load captcha. Please check backend server.');
    } finally {
      btnRefreshCaptcha.disabled = false;
    }
  }

  // STEP 1: PORTAL LOGIN & ACADEMIA CHECK
  portalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(authAlertStep1);

    const netid = document.getElementById('netid').value.trim();
    const portalPassword = document.getElementById('portalPassword').value.trim();
    const captcha = document.getElementById('captchaInput').value.trim();

    if (!netid || !portalPassword || !captcha) {
      showError(authAlertStep1, 'Please fill in all required fields.');
      return;
    }

    setLoadingStep1(true, 'Authenticating Student Portal...');

    try {
      const payload = {
        netid: netid,
        portal_password: portalPassword,
        captcha: captcha,
        cdigest: currentCdigest
      };

      const res = await fetch(`${API_BASE}/api/portal-auth-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!res.ok) {
        const errDetail = data.detail || {};
        if (errDetail.image) {
          captchaImg.src = errDetail.image;
          currentCdigest = errDetail.cdigest || '';
          document.getElementById('captchaInput').value = '';
        } else {
          loadCaptcha();
        }
        showError(authAlertStep1, errDetail.message || 'Portal Login failed. Invalid credentials/captcha.');
        setLoadingStep1(false);
        return;
      }

      // If Academia does NOT exist -> Immediately open dashboard with portal data!
      if (!data.academia_exists) {
        dashboardData = data.dashboard_data;
        openDashboard();
        return;
      }

      // If Academia DOES exist -> Transition to Step 2 screen for Academia password!
      currentSessionToken = data.session_token;
      cachedPortalData = data.portal_data;
      academiaEmailText.textContent = data.academia_email;

      step1Portal.classList.add('hidden');
      step2Academia.classList.remove('hidden');

    } catch (err) {
      showError(authAlertStep1, 'Network error or portal unreachable.');
      loadCaptcha();
    } finally {
      setLoadingStep1(false);
    }
  });

  // STEP 2: ACADEMIA AUTH SUBMIT
  academiaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError(authAlertStep2);

    const academiaPassword = document.getElementById('academiaPassword').value.trim();
    if (!academiaPassword) {
      showError(authAlertStep2, 'Please enter your Academia password.');
      return;
    }

    setLoadingStep2(true, 'Authenticating Academia...');

    try {
      const res = await fetch(`${API_BASE}/api/academia-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_token: currentSessionToken,
          academia_password: academiaPassword
        })
      });

      const data = await res.json();
      if (!res.ok) {
        showError(authAlertStep2, data.detail || 'Academia authentication failed.');
        setLoadingStep2(false);
        return;
      }

      dashboardData = data;
      openDashboard();

    } catch (err) {
      showError(authAlertStep2, 'Network error during Academia authentication.');
    } finally {
      setLoadingStep2(false);
    }
  });

  // SKIP ACADEMIA & USE PORTAL DATA ONLY
  btnSkipAcademia.addEventListener('click', () => {
    if (cachedPortalData) {
      dashboardData = {
        success: true,
        has_academia: false,
        profile: cachedPortalData.profile || {},
        courses: cachedPortalData.courses || {},
        attendance: cachedPortalData.attendance || [],
        monthly: cachedPortalData.monthly || [],
        marks: cachedPortalData.marks || [],
        timetable: cachedPortalData.timetable || {},
        calendar: cachedPortalData.calendar || [],
        day_order: cachedPortalData.day_order || '-'
      };
      openDashboard();
    }
  });

  // Open Dashboard UI
  function openDashboard() {
    renderDashboard();
    step1Portal.classList.add('hidden');
    step2Academia.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    userNav.classList.remove('hidden');
  }

  // Render Full Dashboard
  function renderDashboard() {
    if (!dashboardData) return;

    const { profile, courses, attendance, monthly, marks, timetable, calendar, day_order, has_academia } = dashboardData;

    // Header Info
    userNameChip.textContent = profile.name || profile.regNo || 'Student';
    userAccountType.textContent = has_academia ? 'Academia + Portal' : 'Portal Only';
    userAccountType.className = `badge-tag ${has_academia ? 'badge-academia' : 'badge-portal'}`;

    // Render Tabs
    renderProfile(profile);
    renderCourses(courses);
    renderAttendance(attendance, monthly);
    renderMarks(marks);
    renderTimetable();
    renderCalendar(calendar, day_order);
  }

  // 1. Profile Renderer
  function renderProfile(profile) {
    const grid = document.getElementById('profileGrid');
    const sourceBadge = document.getElementById('profileSourceBadge');
    
    sourceBadge.textContent = dashboardData.has_academia ? 'Academia Source' : 'Portal Source';
    sourceBadge.className = `badge-tag ${dashboardData.has_academia ? 'badge-academia' : 'badge-portal'}`;

    const fields = [
      { title: 'Full Name', val: profile.name || 'N/A' },
      { title: 'Registration No.', val: profile.regNo || 'N/A' },
      { title: 'Program', val: profile.program || 'N/A' },
      { title: 'Department', val: profile.dept || 'N/A' },
      { title: 'Semester', val: profile.semester || 'N/A' },
      { title: 'Batch', val: profile.batch || 'N/A' },
      { title: 'Section', val: profile.section || 'N/A' },
    ];

    grid.innerHTML = fields.map(f => `
      <div class="card glass">
        <div class="card-title">${f.title}</div>
        <div class="card-val">${f.val}</div>
      </div>
    `).join('');
  }

  // 2. Courses Renderer
  function renderCourses(courses) {
    const tbody = document.getElementById('coursesTableBody');
    if (!courses || Object.keys(courses).length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No enrolled courses found.</td></tr>';
      return;
    }

    const courseList = Array.isArray(courses) ? courses : Object.values(courses);
    tbody.innerHTML = courseList.map(c => `
      <tr>
        <td><strong>${c.code || c.courseCode || ''}</strong></td>
        <td>${c.name || c.title || ''}</td>
        <td><span class="badge-tag badge-portal">${c.type || 'Theory'}</span></td>
        <td>${c.slot || '-'}</td>
        <td>${c.room || '-'}</td>
        <td>${c.credits || '-'}</td>
        <td>${c.faculty || '-'}</td>
      </tr>
    `).join('');
  }

  // 3. Attendance Renderer
  function renderAttendance(attendance, monthly) {
    const cardsGrid = document.getElementById('attendanceCardsGrid');
    const monthlyTbody = document.getElementById('monthlyTableBody');

    if (!attendance || attendance.length === 0) {
      cardsGrid.innerHTML = '<div class="glass card" style="grid-column: 1/-1; text-align:center;">No attendance summary data found.</div>';
    } else {
      cardsGrid.innerHTML = attendance.map(c => {
        const pct = parseFloat(c.percent || 0);
        let colorClass = 'att-good';
        if (pct < 75) colorClass = 'att-poor';
        else if (pct < 85) colorClass = 'att-avg';

        return `
          <div class="card glass">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
              <span class="card-title" style="margin:0;">${c.code}</span>
              <span style="font-weight:800; font-size:1.1rem;">${c.percent}%</span>
            </div>
            <div style="font-weight:600; font-size:0.95rem; margin-bottom:0.75rem; color:#fff;">${c.title}</div>
            <div class="progress-bar-bg">
              <div class="progress-bar-fill ${colorClass}" style="width: ${Math.min(pct, 100)}%;"></div>
            </div>
            <div style="display:flex; gap:1.5rem; margin-top:0.75rem; font-size:0.85rem; color:var(--text-muted);">
              <span>Conducted: <strong>${c.conducted}</strong></span>
              <span>Present: <strong>${c.present}</strong></span>
              <span>Absent: <strong>${c.absent}</strong></span>
            </div>
          </div>
        `;
      }).join('');
    }

    if (!monthly || monthly.length === 0) {
      monthlyTbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">No monthly breakdown data found.</td></tr>';
    } else {
      monthlyTbody.innerHTML = monthly.map(m => `
        <tr>
          <td><strong>${m.month}</strong></td>
          <td style="color:var(--accent-emerald);"><strong>${m.present}</strong></td>
          <td style="color:var(--accent-rose);"><strong>${m.absent}</strong></td>
        </tr>
      `).join('');
    }
  }

  // 4. Marks Renderer
  function renderMarks(marks) {
    const grid = document.getElementById('marksGrid');
    if (!marks || marks.length === 0) {
      grid.innerHTML = '<div class="glass card" style="grid-column: 1/-1; text-align:center;">No internal marks data found.</div>';
      return;
    }

    grid.innerHTML = marks.map(m => {
      const assessments = m.assessments || [];
      const assessListHTML = assessments.length > 0 ? assessments.map(a => `
        <div style="display:flex; justify-content:space-between; padding:0.4rem 0; border-bottom:1px solid rgba(255,255,255,0.05); font-size:0.85rem;">
          <span style="color:var(--text-muted);">${a.title}</span>
          <span style="font-weight:700;">${a.marks} / ${a.total}</span>
        </div>
      `).join('') : '<div style="font-size:0.85rem; color:var(--text-dim);">No assessments conducted yet.</div>';

      return `
        <div class="card glass">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.75rem;">
            <div>
              <div class="card-title">${m.courseCode || ''}</div>
              <div style="font-weight:700; color:#fff; font-size:1rem;">${m.title || ''}</div>
            </div>
            <div class="badge-tag badge-portal" style="font-size:0.85rem;">${m.performance || 'N/A'}</div>
          </div>
          <div style="margin-top:1rem;">
            <div style="font-size:0.75rem; font-weight:700; color:var(--text-dim); text-transform:uppercase; margin-bottom:0.5rem;">Component Marks</div>
            ${assessListHTML}
          </div>
        </div>
      `;
    }).join('');
  }

  // 5. Timetable Renderer
  function renderTimetable() {
    const tbody = document.getElementById('timetableTableBody');
    const schedule = dashboardData ? dashboardData.timetable : null;

    if (!schedule || !schedule[currentTimetableDay]) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;">No classes scheduled for ${currentTimetableDay}.</td></tr>`;
      return;
    }

    const daySlots = schedule[currentTimetableDay];
    tbody.innerHTML = Object.entries(daySlots).map(([timeStr, info]) => `
      <tr>
        <td><strong>${timeStr}</strong></td>
        <td><span class="badge-tag badge-academia">${info.slot || '-'}</span></td>
        <td><strong>${info.code || ''}</strong></td>
        <td>${info.course || ''}</td>
        <td>${info.room || '-'}</td>
      </tr>
    `).join('');
  }

  // 6. Calendar Renderer
  function renderCalendar(calendar, dayOrder) {
    const tbody = document.getElementById('calendarTableBody');
    const dayOrderTag = document.getElementById('dayOrderTag');

    dayOrderTag.textContent = `Today's Day Order: ${dayOrder || '-'}`;

    if (!calendar || calendar.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">No academic calendar entries found.</td></tr>';
      return;
    }

    tbody.innerHTML = calendar.slice(0, 30).map(entry => `
      <tr>
        <td><strong>${entry.date || ''}</strong></td>
        <td>${entry.day || ''}</td>
        <td><span class="badge-tag ${entry.dayOrder ? 'badge-academia' : ''}">${entry.dayOrder || '-'}</span></td>
        <td>${entry.description || ''}</td>
      </tr>
    `).join('');
  }

  // Helpers
  function showError(element, msg) {
    element.textContent = msg;
    element.classList.remove('hidden');
  }

  function hideError(element) {
    element.classList.add('hidden');
  }

  function setLoadingStep1(isLoading, statusText = 'Sign In & Check Account') {
    btnStep1Submit.disabled = isLoading;
    step1BtnText.textContent = isLoading ? statusText : 'Sign In & Check Account';
  }

  function setLoadingStep2(isLoading, statusText = 'Authenticate & Open Dashboard') {
    btnStep2Submit.disabled = isLoading;
    step2BtnText.textContent = isLoading ? statusText : 'Authenticate & Open Dashboard';
  }
});
