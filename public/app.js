document.addEventListener('DOMContentLoaded', () => {
  const searchBtn = document.getElementById('search-btn');
  const container = document.getElementById('opportunities-container');

  function renderCard(opp, searchThreshold) {
    const threshold = searchThreshold != null ? searchThreshold : (opp.notificationThreshold || 85);
    const meetsThreshold = threshold === 0 || opp.matchScore >= threshold;
    const matchClass = meetsThreshold ? 'match-high' : 'match-review';

    const strengths = (opp.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
    const risks = (opp.risks || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');

    return `
      <article class="opp-card">
        <div class="opp-card-header">
          <span class="match-badge ${matchClass}">${opp.matchScore}%</span>
          <div>
            <h3>${escapeHtml(opp.title)}</h3>
            <p class="opp-employer">${escapeHtml(opp.employer)}</p>
          </div>
        </div>

        <dl class="opp-meta">
          <div><dt>Level</dt><dd>${opp.level || '—'}</dd></div>
          <div><dt>Qualification</dt><dd>${escapeHtml(opp.qualification || 'Not specified')}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(opp.location || 'Unknown')}${opp.distance ? ' (' + opp.distance + ' mi)' : ''}</dd></div>
          <div><dt>Salary</dt><dd>${escapeHtml(opp.salary || 'Not listed')}</dd></div>
          <div><dt>Deadline</dt><dd>${formatDate(opp.deadline)}</dd></div>
        </dl>

        <div class="opp-eligibility">
          <p class="opp-eligibility-label">Eligibility needs confirmation</p>
          <p class="opp-eligibility-detail">${escapeHtml(opp.eligibility || 'Ibrahim appears eligible, but the employer should confirm that his particular T Level meets the Level 6 entry requirements.')}</p>
        </div>

        <details class="opp-details">
          <summary>
            <span class="opp-details-title">Strengths &amp; Risks</span>
            <span class="opp-details-helper">Expand to see why this opportunity received an ${opp.matchScore}% match.</span>
          </summary>
          <div class="opp-strengths">
            <h4>Strengths</h4>
            <ul>${strengths || '<li>None listed</li>'}</ul>
          </div>
          <div class="opp-risks">
            <h4>Risks</h4>
            <ul>${risks || '<li>None listed</li>'}</ul>
          </div>
        </details>

        <div class="opp-actions">
          <span class="opp-review-label">${threshold === 0
            ? `Free search &mdash; showing this matching vacancy regardless of suitability score.`
            : meetsThreshold
              ? `Meets minimum suitability score &mdash; ${opp.matchScore}% is at or above ${threshold}%.`
              : `Review opportunity &mdash; ${opp.matchScore}% is below the ${threshold}% minimum.`}</span>
          <a href="${escapeHtml(opp.url)}" target="_blank" rel="noopener" class="btn-primary btn-small">View on GOV.UK ↗</a>
        </div>
      </article>`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return 'Unknown';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function getSelectedLevels(name) {
    return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(el => el.value);
  }

  searchBtn.addEventListener('click', async () => {
    const levels = getSelectedLevels('level');
    const mechLevels = getSelectedLevels('mech-level');
    const dataLevels = getSelectedLevels('data-level');

    if (levels.length === 0 && mechLevels.length === 0 && dataLevels.length === 0) {
      container.innerHTML = '<p class="validation-error">Select at least one apprenticeship level before searching.</p>';
      return;
    }

    container.innerHTML = '<p class="empty-state">Searching&hellip;</p>';

    try {
      const distance = document.getElementById('travel-distance').value;
      const threshold = document.getElementById('threshold').value;
      const programme = document.getElementById('programme-select')?.value || '';

      const preferences = {
        programme,
        levels,
        distance,
        threshold,
      };
      if (mechLevels.length) preferences.mechLevels = mechLevels;
      if (dataLevels.length) preferences.dataLevels = dataLevels;

      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences })
      });

      const data = await res.json();

      if (data.error) {
        container.innerHTML = `<p class="validation-error">${escapeHtml(data.message)}</p>`;
        return;
      }

      if (!data.opportunities || !data.opportunities.length) {
        container.innerHTML = `<p class="empty-state">${escapeHtml(data.message || 'No opportunities found.')}</p>`;
        return;
      }

      let html = '';
      if (data.message) {
        html += `<p class="search-message">${escapeHtml(data.message)}${data.effectiveDistance ? ' (within ' + data.effectiveDistance + ' miles)' : ''}</p>`;
      }
      html += data.opportunities.map(o => renderCard(o, data.searchThreshold)).join('');
      container.innerHTML = html;
    } catch {
      container.innerHTML = '<p class="empty-state">Could not reach the server. Please try again.</p>';
    }
  });

  // Stage 2: Document Extraction Handler
  const extractDocForm = document.getElementById('extract-doc-form');
  const extractDetailsBtn = document.getElementById('extract-details-btn');
  const extractLoading = document.getElementById('extract-loading');
  const extractError = document.getElementById('extract-error');
  const confirmVacancyForm = document.getElementById('confirm-vacancy-form');
  const documentUpload = document.getElementById('document-upload');

  if (extractDocForm) {
    extractDocForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!documentUpload || !documentUpload.files || !documentUpload.files.length) {
        if (extractError) {
          extractError.textContent = 'Please select a document file to upload.';
          extractError.style.display = 'block';
        }
        return;
      }

      const file = documentUpload.files[0];
      const formData = new FormData();
      formData.append('file', file);

      if (extractDetailsBtn) extractDetailsBtn.disabled = true;
      if (extractLoading) extractLoading.style.display = 'inline';
      if (extractError) extractError.style.display = 'none';

      try {
        const res = await fetch('/api/extract-document', {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();

        if (!res.ok || data.error) {
          if (extractError) {
            extractError.textContent = data.message || 'Extraction failed. Please check the file and try again.';
            extractError.style.display = 'block';
          }
          if (confirmVacancyForm) confirmVacancyForm.style.display = 'none';
          return;
        }

        const ext = data.extracted || {};
        if (document.getElementById('edit-title')) document.getElementById('edit-title').value = ext.title || '';
        if (document.getElementById('edit-employer')) document.getElementById('edit-employer').value = ext.employer || '';
        if (document.getElementById('edit-location')) document.getElementById('edit-location').value = ext.location || '';
        if (document.getElementById('edit-salary')) document.getElementById('edit-salary').value = ext.salary || '';
        if (document.getElementById('edit-deadline')) document.getElementById('edit-deadline').value = ext.deadline || '';
        if (document.getElementById('edit-level')) document.getElementById('edit-level').value = ext.level != null ? ext.level : '';
        if (document.getElementById('edit-qualification')) document.getElementById('edit-qualification').value = ext.qualification || '';
        if (document.getElementById('edit-trainingProvider')) document.getElementById('edit-trainingProvider').value = ext.trainingProvider || '';
        if (document.getElementById('edit-description')) document.getElementById('edit-description').value = ext.description || '';
        if (document.getElementById('edit-requirements')) document.getElementById('edit-requirements').value = ext.requirements || '';
        if (document.getElementById('edit-sourceFilename')) document.getElementById('edit-sourceFilename').value = ext.sourceFilename || file.name || '';

        if (confirmVacancyForm) confirmVacancyForm.style.display = 'block';
        const confirmAssessBtn = document.getElementById('confirm-assess-btn');
        if (confirmAssessBtn) confirmAssessBtn.disabled = false;
      } catch {
        if (extractError) {
          extractError.textContent = 'Could not reach server to extract document.';
          extractError.style.display = 'block';
        }
      } finally {
        if (extractDetailsBtn) extractDetailsBtn.disabled = false;
        if (extractLoading) extractLoading.style.display = 'none';
      }
    });
  }

  // Stage 3: Confirmation & Manual Opportunity Assessment Handler
  if (confirmVacancyForm) {
    confirmVacancyForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const confirmAssessBtn = document.getElementById('confirm-assess-btn');
      const manualContainer = document.getElementById('manual-result-container');
      const title = document.getElementById('edit-title')?.value.trim();
      const employer = document.getElementById('edit-employer')?.value.trim();
      const level = document.getElementById('edit-level')?.value.trim();

      if (!title || !employer || !level) {
        if (manualContainer) {
          manualContainer.innerHTML = '<p class="validation-error">Title, employer, and apprenticeship level are required.</p>';
        }
        return;
      }

      const vacancy = {
        title,
        employer,
        location: document.getElementById('edit-location')?.value.trim() || '',
        salary: document.getElementById('edit-salary')?.value.trim() || '',
        deadline: document.getElementById('edit-deadline')?.value.trim() || '',
        level,
        qualification: document.getElementById('edit-qualification')?.value.trim() || '',
        trainingProvider: document.getElementById('edit-trainingProvider')?.value.trim() || '',
        description: document.getElementById('edit-description')?.value.trim() || '',
        requirements: document.getElementById('edit-requirements')?.value.trim() || '',
        sourceFilename: document.getElementById('edit-sourceFilename')?.value.trim() || '',
      };

      const distance = document.getElementById('travel-distance')?.value || '25';
      const threshold = document.getElementById('threshold')?.value || '85';
      const programme = document.getElementById('programme-select')?.value || '';
      const levels = Array.from(document.querySelectorAll('input[name="levels"]:checked')).map(cb => cb.value);

      const preferences = { programme, levels, distance, threshold };

      if (confirmAssessBtn) {
        confirmAssessBtn.disabled = true;
        confirmAssessBtn.textContent = 'Assessing opportunity...';
      }

      try {
        const res = await fetch('/api/assess-manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vacancy, preferences }),
        });

        const data = await res.json();

        if (!res.ok || !data.accepted) {
          if (manualContainer) {
            manualContainer.innerHTML = `<p class="validation-error">${escapeHtml(data.message || 'Assessment rejected.')}</p>`;
          }
          return;
        }

        if (data.opportunity && manualContainer) {
          manualContainer.innerHTML = renderCard(data.opportunity, data.searchThreshold);
        }
      } catch {
        if (manualContainer) {
          manualContainer.innerHTML = '<p class="validation-error">Could not reach server to complete assessment.</p>';
        }
      } finally {
        if (confirmAssessBtn) {
          confirmAssessBtn.disabled = false;
          confirmAssessBtn.textContent = 'Confirm and assess';
        }
      }
    });
  }
});
