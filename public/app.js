document.addEventListener('DOMContentLoaded', () => {
  const searchBtn = document.getElementById('search-btn');
  const container = document.getElementById('opportunities-container');

  function renderCard(opp, searchThreshold) {
    const threshold = searchThreshold != null ? searchThreshold : (opp.notificationThreshold || 85);
    const meetsThreshold = opp.matchScore >= threshold;
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
          <span class="opp-review-label">${meetsThreshold
            ? `Meets alert threshold &mdash; ${opp.matchScore}% is at or above the ${threshold}% email-alert threshold.`
            : `Review opportunity &mdash; ${opp.matchScore}% is below the ${threshold}% email-alert threshold.`}</span>
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
    const mechLevels = getSelectedLevels('mech-level');
    const dataLevels = getSelectedLevels('data-level');

    if (mechLevels.length === 0 && dataLevels.length === 0) {
      container.innerHTML = '<p class="validation-error">Select at least one mechanical or data apprenticeship level before searching.</p>';
      return;
    }

    container.innerHTML = '<p class="empty-state">Searching&hellip;</p>';

    try {
      const distance = document.getElementById('travel-distance').value;
      const threshold = document.getElementById('threshold').value;

      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: {
            distance,
            mechLevels,
            dataLevels,
            threshold,
          }
        })
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
});
