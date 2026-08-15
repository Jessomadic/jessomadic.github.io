(function () {
  function applyTheme(isDarkMode) {
    document.documentElement.classList.toggle("dark", isDarkMode);
    localStorage.setItem("color-theme", isDarkMode ? "dark" : "light");
    document.querySelectorAll("[data-theme-dark-icon]").forEach(function (icon) {
      icon.classList.toggle("hidden", isDarkMode);
    });
    document.querySelectorAll("[data-theme-light-icon]").forEach(function (icon) {
      icon.classList.toggle("hidden", !isDarkMode);
    });
  }

  function showToaster(message) {
    var toaster = document.createElement("div");
    toaster.className = "toaster";
    toaster.setAttribute("role", "status");
    toaster.textContent = message;
    document.body.appendChild(toaster);
    window.setTimeout(function () {
      toaster.classList.add("show");
    }, 10);
    window.setTimeout(function () {
      toaster.classList.remove("show");
      window.setTimeout(function () {
        toaster.remove();
      }, 200);
    }, 2800);
  }

  window.copyToClipboard = function (text, successMessage) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      function () {
        showToaster(successMessage || "Copied to clipboard.");
      },
      function () {
        showToaster("Copy failed.");
      }
    );
  };

  function updateRochesterTime() {
    var now = new Date();
    var formatter = new Intl.DateTimeFormat([], {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    });

    document.querySelectorAll("[data-local-time]").forEach(function (element) {
      element.dateTime = now.toISOString();
      element.textContent = formatter.format(now);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var mobileMenu = document.getElementById("mobile-menu");
    var mobileMenuButton = document.getElementById("mobile-menu-button");
    var mobileMenuClose = document.getElementById("mobile-menu-close");
    var lastFocusedElement = null;

    function openMobileMenu() {
      if (!mobileMenu) return;
      lastFocusedElement = document.activeElement;
      mobileMenu.classList.remove("hidden");
      mobileMenu.setAttribute("aria-hidden", "false");
      if (mobileMenuButton) mobileMenuButton.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden";
      if (mobileMenuClose) mobileMenuClose.focus();
    }

    function closeMobileMenu() {
      if (!mobileMenu) return;
      mobileMenu.classList.add("hidden");
      mobileMenu.setAttribute("aria-hidden", "true");
      if (mobileMenuButton) mobileMenuButton.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") lastFocusedElement.focus();
    }

    if (mobileMenuButton) mobileMenuButton.addEventListener("click", openMobileMenu);
    if (mobileMenuClose) mobileMenuClose.addEventListener("click", closeMobileMenu);
    if (mobileMenu) {
      mobileMenu.addEventListener("click", function (event) {
        if (event.target === mobileMenu) closeMobileMenu();
      });
    }
    document.querySelectorAll("[data-menu-link]").forEach(function (link) {
      link.addEventListener("click", closeMobileMenu);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeMobileMenu();
    });

    var isDarkMode =
      localStorage.getItem("color-theme") === "dark" ||
      (!("color-theme" in localStorage) && window.matchMedia("(prefers-color-scheme: dark)").matches);
    applyTheme(isDarkMode);

    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        applyTheme(!document.documentElement.classList.contains("dark"));
      });
    });

    updateRochesterTime();
    window.setInterval(updateRochesterTime, 30000);
  });
})();
