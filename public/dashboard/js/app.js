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
    loadTransactionHistory()
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
