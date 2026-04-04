import { test, expect } from '@playwright/test';

/**
 * E2E tests for heartbeat disconnect/reconnect behavior.
 *
 * Verifies that when the server heartbeat drops, the UI shows a
 * "reconnecting" banner instead of resetting to onboarding, and
 * recovers automatically when the heartbeat returns.
 *
 * Uses browser offline mode to break the existing EventSource connection
 * (page.route only intercepts new requests, not established SSE streams).
 */

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:4747';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

test.beforeAll(async () => {
  if (process.env.E2E) return;
  try {
    const [backendRes, frontendRes] = await Promise.allSettled([
      fetch(`${BACKEND_URL}/api/repos`),
      fetch(FRONTEND_URL),
    ]);
    if (
      backendRes.status === 'rejected' ||
      (backendRes.status === 'fulfilled' && !backendRes.value.ok)
    ) {
      test.skip(true, 'gitnexus serve not available');
      return;
    }
    if (
      frontendRes.status === 'rejected' ||
      (frontendRes.status === 'fulfilled' && !frontendRes.value.ok)
    ) {
      test.skip(true, 'Vite dev server not available');
      return;
    }
    if (backendRes.status === 'fulfilled') {
      const repos = await backendRes.value.json();
      if (!repos.length) {
        test.skip(true, 'No indexed repos');
        return;
      }
    }
  } catch {
    test.skip(true, 'servers not available');
  }
});

/** Load the app, select a repo, and wait for the graph to appear. */
async function waitForGraphLoaded(page: import('@playwright/test').Page) {
  await page.goto('/');

  const landingCard = page.locator('[data-testid="landing-repo-card"]').first();
  try {
    await landingCard.waitFor({ state: 'visible', timeout: 15_000 });
    await landingCard.click();
  } catch {
    // Landing screen may not appear (e.g. ?server auto-connect)
  }

  await expect(page.locator('[data-testid="status-ready"]')).toBeVisible({ timeout: 30_000 });
}

test.describe('Heartbeat Reconnect', () => {
  test('shows reconnecting banner when heartbeat fails, not onboarding reset', async ({
    page,
    context,
  }) => {
    await waitForGraphLoaded(page);

    // Verify we're in the exploring view
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible();

    // Go offline — this breaks the existing EventSource SSE connection,
    // unlike page.route() which only intercepts new requests.
    await context.setOffline(true);

    // Wait for the reconnecting banner to appear
    const banner = page.getByText('Server connection lost');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // The graph canvas should STILL be visible — not reset to onboarding
    await expect(page.locator('canvas').first()).toBeVisible();

    // Clean up
    await context.setOffline(false);
  });

  test('recovers when network returns after disconnect', async ({ page, context }) => {
    await waitForGraphLoaded(page);

    // Go offline to trigger disconnect
    await context.setOffline(true);

    const banner = page.getByText('Server connection lost');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Come back online — heartbeat should reconnect automatically
    await context.setOffline(false);

    // Banner should disappear
    await expect(banner).not.toBeVisible({ timeout: 30_000 });

    // Graph should still be there
    await expect(page.locator('[data-testid="status-ready"]')).toBeVisible();
  });
});
