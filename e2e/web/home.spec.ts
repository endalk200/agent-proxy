import { expect, test } from "@playwright/test"

test("serves the dashboard shell", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveTitle("agent-proxy")
  await expect(page.getByRole("heading", { level: 1, name: "agent-proxy" })).toBeVisible()
})
