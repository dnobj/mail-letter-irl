/**
 * Letter IRL Dashboard JavaScript
 */

// Check authentication on page load
window.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  await loadDashboard();
});

/**
 * Check if user is authenticated
 */
async function checkAuth() {
  try {
    const response = await fetch('/api/users/me', {
      credentials: 'include'
    });

    if (!response.ok) {
      // Not authenticated, redirect to login
      window.location.href = '/dashboard/index.html';
      return;
    }

    const user = await response.json();
    displayUserInfo(user);
  } catch (error) {
    console.error('Auth check failed:', error);
    window.location.href = '/dashboard/index.html';
  }
}

/**
 * Display user information in header
 */
function displayUserInfo(user) {
  const userInfoEl = document.getElementById('user-info');
  if (userInfoEl) {
    userInfoEl.textContent = `Signed in as ${user.email || user.user_id}`;
  }
}

/**
 * Load dashboard data
 */
async function loadDashboard() {
  await Promise.all([
    loadBalance(),
    loadTransactionHistory(),
    loadTokens()
  ]);
}

/**
 * Load and display credit balance
 */
async function loadBalance() {
  try {
    const response = await fetch('/api/credits/balance', {
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      const balanceEl = document.getElementById('balance');
      if (balanceEl) {
        balanceEl.textContent = data.credits || 0;
      }
    } else {
      console.error('Failed to load balance');
      document.getElementById('balance').textContent = '--';
    }
  } catch (error) {
    console.error('Error loading balance:', error);
    document.getElementById('balance').textContent = '--';
  }
}

/**
 * Load and display transaction history
 */
async function loadTransactionHistory() {
  try {
    const response = await fetch('/api/credits/transactions', {
      credentials: 'include'
    });

    const historyContent = document.getElementById('history-content');

    if (response.ok) {
      const data = await response.json();
      const transactions = data.transactions || [];

      if (transactions.length === 0) {
        historyContent.innerHTML = `
          <div class="empty-state">
            <p>No transactions yet. Purchase credits to get started!</p>
          </div>
        `;
        return;
      }

      // Build table
      let tableHTML = `
        <table class="history-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Description</th>
              <th>Credits</th>
              <th>Balance</th>
            </tr>
          </thead>
          <tbody>
      `;

      transactions.forEach(tx => {
        const date = new Date(tx.created_at).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });

        const creditsClass = tx.credits > 0 ? 'status-completed' : '';
        const creditsText = tx.credits > 0 ? `+${tx.credits}` : tx.credits;

        tableHTML += `
          <tr>
            <td>${date}</td>
            <td><span class="status-badge ${creditsClass}">${tx.type}</span></td>
            <td>${tx.description || '-'}</td>
            <td style="font-weight: 600; color: ${tx.credits > 0 ? '#10b981' : '#ef4444'};">${creditsText}</td>
            <td>${tx.balance_after}</td>
          </tr>
        `;
      });

      tableHTML += `
          </tbody>
        </table>
      `;

      historyContent.innerHTML = tableHTML;
    } else {
      historyContent.innerHTML = `
        <div class="empty-state">
          <p>Failed to load transaction history</p>
        </div>
      `;
    }
  } catch (error) {
    console.error('Error loading transaction history:', error);
    document.getElementById('history-content').innerHTML = `
      <div class="empty-state">
        <p>Error loading transaction history</p>
      </div>
    `;
  }
}

/**
 * Initiate credit purchase via Stripe Checkout
 */
async function purchaseCredits(productId) {
  try {
    // Disable all purchase buttons to prevent double-clicks
    const buttons = document.querySelectorAll('.package-card .btn');
    buttons.forEach(btn => {
      btn.disabled = true;
      btn.textContent = 'Processing...';
    });

    const response = await fetch('/api/stripe/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({
        productId,
        successUrl: `${window.location.origin}/dashboard/app.html?purchase=success`,
        cancelUrl: `${window.location.origin}/dashboard/app.html?purchase=cancelled`
      })
    });

    if (response.ok) {
      const data = await response.json();

      if (data.sessionUrl) {
        // Redirect to Stripe Checkout
        window.location.href = data.sessionUrl;
      } else {
        alert('Failed to create checkout session. Please try again.');
        resetPurchaseButtons();
      }
    } else {
      const error = await response.json();
      alert(`Purchase failed: ${error.error || 'Unknown error'}`);
      resetPurchaseButtons();
    }
  } catch (error) {
    console.error('Error initiating purchase:', error);
    alert('An error occurred. Please try again.');
    resetPurchaseButtons();
  }
}

/**
 * Reset purchase buttons after error
 */
function resetPurchaseButtons() {
  const buttons = document.querySelectorAll('.package-card .btn');
  buttons.forEach((btn, index) => {
    btn.disabled = false;
    if (index === 0) btn.textContent = 'Purchase Starter Pack';
    if (index === 1) btn.textContent = 'Purchase Regular Pack';
    if (index === 2) btn.textContent = 'Purchase Power Pack';
  });
}

/**
 * Handle logout
 */
function logout() {
  // Clear session and redirect to login
  fetch('/auth/logout', {
    method: 'POST',
    credentials: 'include'
  }).finally(() => {
    window.location.href = '/dashboard/index.html';
  });
}

/**
 * Check for purchase result in URL params
 */
function checkPurchaseResult() {
  const urlParams = new URLSearchParams(window.location.search);
  const purchase = urlParams.get('purchase');

  if (purchase === 'success') {
    // Show success message
    alert('Purchase successful! Your credits have been added.');
    // Reload balance
    loadBalance();
    loadTransactionHistory();
    // Clean up URL
    window.history.replaceState({}, document.title, '/dashboard/app.html');
  } else if (purchase === 'cancelled') {
    alert('Purchase was cancelled.');
    // Clean up URL
    window.history.replaceState({}, document.title, '/dashboard/app.html');
  }
}

// Check for purchase result on load
window.addEventListener('DOMContentLoaded', checkPurchaseResult);

// ============================================================================
// API Token Management
// ============================================================================

// Store newly created token for copy function
let newlyCreatedToken = null;

/**
 * Load and display user's API tokens
 */
async function loadTokens() {
  const tokensContent = document.getElementById('tokens-content');
  if (!tokensContent) return;

  try {
    const response = await fetch('/api/tokens', {
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      const tokens = data.tokens || [];

      if (tokens.length === 0) {
        tokensContent.innerHTML = `
          <div class="empty-state">
            <p>No API tokens yet. Create one to get started with MCP clients.</p>
          </div>
        `;
        return;
      }

      // Build token list
      let listHTML = '<div class="token-list">';

      tokens.forEach(token => {
        const createdDate = new Date(token.createdAt).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });

        const lastUsed = token.lastUsedAt
          ? new Date(token.lastUsedAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            })
          : 'Never';

        const expiresAt = token.expiresAt
          ? new Date(token.expiresAt).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric'
            })
          : 'Never';

        const isActive = token.status === 'active';
        const statusClass = isActive ? 'status-active' : 'status-revoked';
        const statusText = isActive ? 'Active' : 'Revoked';

        listHTML += `
          <div class="token-item ${isActive ? '' : 'token-revoked'}">
            <div class="token-info">
              <div class="token-name">${escapeHtml(token.name)}</div>
              <div class="token-meta">
                <span class="token-prefix">lirl_pat_...${token.tokenPrefix}</span>
                <span class="token-separator">|</span>
                <span>Created: ${createdDate}</span>
                <span class="token-separator">|</span>
                <span>Last used: ${lastUsed}</span>
                <span class="token-separator">|</span>
                <span>Expires: ${expiresAt}</span>
              </div>
            </div>
            <div class="token-actions">
              <span class="status-badge ${statusClass}">${statusText}</span>
              ${isActive ? `<button class="btn btn-danger btn-small" onclick="revokeToken(${token.tokenId})">Revoke</button>` : ''}
            </div>
          </div>
        `;
      });

      listHTML += '</div>';
      tokensContent.innerHTML = listHTML;
    } else {
      tokensContent.innerHTML = `
        <div class="empty-state">
          <p>Failed to load API tokens</p>
        </div>
      `;
    }
  } catch (error) {
    console.error('Error loading tokens:', error);
    tokensContent.innerHTML = `
      <div class="empty-state">
        <p>Error loading API tokens</p>
      </div>
    `;
  }
}

/**
 * Create a new API token
 */
async function createToken() {
  const nameInput = document.getElementById('token-name');
  const name = nameInput.value.trim();

  if (!name) {
    alert('Please enter a name for the token');
    nameInput.focus();
    return;
  }

  if (name.length > 100) {
    alert('Token name must be 100 characters or less');
    return;
  }

  try {
    const response = await fetch('/api/tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ name })
    });

    if (response.ok) {
      const data = await response.json();

      // Store token for copy function
      newlyCreatedToken = data.token;

      // Display the new token
      const displayDiv = document.getElementById('new-token-display');
      const valueEl = document.getElementById('new-token-value');
      valueEl.textContent = data.token;
      displayDiv.style.display = 'block';

      // Clear input
      nameInput.value = '';

      // Reload token list
      await loadTokens();

      // Scroll to the new token display
      displayDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      const error = await response.json();
      alert(`Failed to create token: ${error.message || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Error creating token:', error);
    alert('An error occurred while creating the token');
  }
}

/**
 * Copy the newly created token to clipboard
 */
async function copyToken() {
  if (!newlyCreatedToken) {
    alert('No token to copy');
    return;
  }

  try {
    await navigator.clipboard.writeText(newlyCreatedToken);

    // Update button text temporarily
    const copyBtn = document.querySelector('#new-token-display .btn');
    const originalText = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    copyBtn.disabled = true;

    setTimeout(() => {
      copyBtn.textContent = originalText;
      copyBtn.disabled = false;
    }, 2000);
  } catch (error) {
    console.error('Failed to copy:', error);
    // Fallback: select the text
    const valueEl = document.getElementById('new-token-value');
    const range = document.createRange();
    range.selectNode(valueEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    alert('Press Ctrl+C to copy the selected token');
  }
}

/**
 * Revoke an API token
 */
async function revokeToken(tokenId) {
  if (!confirm('Are you sure you want to revoke this token? This action cannot be undone.')) {
    return;
  }

  try {
    const response = await fetch(`/api/tokens/${tokenId}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (response.ok) {
      // Reload token list
      await loadTokens();
    } else {
      const error = await response.json();
      alert(`Failed to revoke token: ${error.message || 'Unknown error'}`);
    }
  } catch (error) {
    console.error('Error revoking token:', error);
    alert('An error occurred while revoking the token');
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
