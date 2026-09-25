"""Smoke test for the Smart QR Attendance web application.

Run with:
    python test_website.py

ChromeDriver is resolved by Selenium Manager, which is included with
Selenium 4. No Selenium 3 APIs are used in this file.
"""

import logging
import sys
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


DEFAULT_WAIT_SECONDS = 20
RENDER_URL = "https://onrender.com"
ADMIN_EMAIL = "admin@college.edu"
ADMIN_PASSWORD = "SVHEC"
LOGGER = logging.getLogger(__name__)


def create_driver() -> webdriver.Chrome:
    """Create a Chrome WebDriver suitable for local execution."""
    options = Options()
    options.add_argument("--window-size=1440,1000")
    options.add_argument("--disable-notifications")
    return webdriver.Chrome(options=options)


def wait_for_login_page(wait: WebDriverWait) -> None:
    """Wait until the SPA has rendered its login controls."""
    wait.until(EC.visibility_of_element_located((By.ID, "loginView")))
    wait.until(EC.element_to_be_clickable((By.XPATH, "//button[normalize-space()='Admin']")))
    wait.until(EC.visibility_of_element_located((By.ID, "loginPassword")))


def login_as_admin(driver: webdriver.Chrome, wait: WebDriverWait, password: str) -> None:
    """Log in through the same controls a user sees in the browser."""
    admin_role_button = wait.until(
        EC.element_to_be_clickable((By.XPATH, "//button[normalize-space()='Admin']"))
    )
    admin_role_button.click()

    password_input = wait.until(
        EC.visibility_of_element_located((By.ID, "loginPassword"))
    )
    password_input.clear()
    password_input.send_keys(password)

    login_button = wait.until(
        EC.element_to_be_clickable((By.ID, "loginSubmitBtn"))
    )
    login_button.click()

    # The application is an SPA, so a successful login changes visible views
    # instead of navigating to a different URL.
    wait.until(EC.invisibility_of_element_located((By.ID, "loginView")))
    wait.until(EC.visibility_of_element_located((By.ID, "adminPortal")))
    wait.until(EC.visibility_of_element_located((By.ID, "navUserBadge")))


def run_smoke_test() -> None:
    """Navigate to the deployment and verify the admin login flow."""
    driver = None
    screenshot_path = Path("selenium_failure.png").resolve()

    try:
        driver = create_driver()
        wait = WebDriverWait(driver, DEFAULT_WAIT_SECONDS)

        LOGGER.info("Opening %s", RENDER_URL)
        driver.get(RENDER_URL)
        wait_for_login_page(wait)

        email_input = wait.until(
            EC.visibility_of_element_located((By.ID, "loginEmail"))
        )
        # Admin email is prefilled by the application, but setting it here
        # makes the test independent of that UI default.
        if email_input.is_enabled():
            email_input.clear()
            email_input.send_keys(ADMIN_EMAIL)

        login_as_admin(driver, wait, ADMIN_PASSWORD)

        user_role = wait.until(
            EC.visibility_of_element_located((By.ID, "navUserRole"))
        )
        assert user_role.text.strip().upper() == "ADMIN", (
            f"Expected ADMIN role, got {user_role.text!r}"
        )
        LOGGER.info("Admin login smoke test passed")

    except (AssertionError, TimeoutException, WebDriverException, RuntimeError):
        if driver is not None:
            try:
                driver.save_screenshot(str(screenshot_path))
                LOGGER.error("Failure screenshot saved to %s", screenshot_path)
            except WebDriverException:
                LOGGER.exception("Could not save failure screenshot")
        raise
    finally:
        if driver is not None:
            driver.quit()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        run_smoke_test()
    except Exception as error:
        LOGGER.error("Selenium smoke test failed: %s", error)
        sys.exit(1)