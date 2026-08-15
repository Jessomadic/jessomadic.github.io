(function () {
  "use strict";

  function storedTheme() {
    try {
      return localStorage.getItem("color-theme");
    } catch (error) {
      return null;
    }
  }

  function applyTheme(isDarkMode) {
    document.documentElement.classList.toggle("dark", isDarkMode);
    try {
      localStorage.setItem("color-theme", isDarkMode ? "dark" : "light");
    } catch (error) {
      // The selected theme still applies for this page when storage is unavailable.
    }

    document.querySelectorAll("[data-theme-dark-icon]").forEach(function (icon) {
      icon.classList.toggle("hidden", isDarkMode);
    });
    document.querySelectorAll("[data-theme-light-icon]").forEach(function (icon) {
      icon.classList.toggle("hidden", !isDarkMode);
    });
    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.setAttribute("aria-label", isDarkMode ? "Switch to light theme" : "Switch to dark theme");
    });
  }

  function showToaster(message) {
    var toaster = document.createElement("div");
    toaster.className = "toaster";
    toaster.setAttribute("role", "status");
    toaster.setAttribute("aria-live", "polite");
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

  window.copyToClipboard = function (value, successMessage) {
    if (!value || !navigator.clipboard) return;
    navigator.clipboard.writeText(value).then(
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
    var savedTheme = storedTheme();
    var isDarkMode = savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches);
    applyTheme(isDarkMode);

    document.querySelectorAll("[data-theme-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        applyTheme(!document.documentElement.classList.contains("dark"));
      });
    });

    var mobileMenu = document.getElementById("mobile-menu");
    var mobileMenuButton = document.getElementById("mobile-menu-button");
    var mobileMenuClose = document.getElementById("mobile-menu-close");
    var lastFocusedElement = null;
    var focusableSelector = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

    function menuFocusableElements() {
      return mobileMenu ? Array.prototype.slice.call(mobileMenu.querySelectorAll(focusableSelector)).filter(function (element) {
        return !element.hasAttribute("hidden") && element.getClientRects().length > 0;
      }) : [];
    }

    function openMobileMenu() {
      if (!mobileMenu) return;
      lastFocusedElement = document.activeElement;
      mobileMenu.classList.remove("hidden");
      mobileMenu.setAttribute("aria-hidden", "false");
      if (mobileMenuButton) mobileMenuButton.setAttribute("aria-expanded", "true");
      document.body.classList.add("menu-open");
      if (mobileMenuClose) mobileMenuClose.focus();
    }

    function closeMobileMenu(restoreFocus) {
      if (!mobileMenu || mobileMenu.classList.contains("hidden")) return;
      mobileMenu.classList.add("hidden");
      mobileMenu.setAttribute("aria-hidden", "true");
      if (mobileMenuButton) mobileMenuButton.setAttribute("aria-expanded", "false");
      document.body.classList.remove("menu-open");
      if (restoreFocus !== false && lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
    }

    if (mobileMenuButton) mobileMenuButton.addEventListener("click", openMobileMenu);
    if (mobileMenuClose) mobileMenuClose.addEventListener("click", function () { closeMobileMenu(true); });
    if (mobileMenu) {
      mobileMenu.addEventListener("click", function (event) {
        if (event.target === mobileMenu) closeMobileMenu(true);
      });
    }
    document.querySelectorAll("[data-menu-link]").forEach(function (link) {
      link.addEventListener("click", function () { closeMobileMenu(false); });
    });
    document.addEventListener("keydown", function (event) {
      if (!mobileMenu || mobileMenu.classList.contains("hidden")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileMenu(true);
        return;
      }
      if (event.key !== "Tab") return;
      var focusable = menuFocusableElements();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth >= 1024) closeMobileMenu(false);
    });

    var carousel = document.querySelector("[data-skill-carousel]");
    var carouselToggle = document.querySelector("[data-carousel-toggle]");
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function updateMotionPreference() {
      if (!carousel) return;
      carousel.classList.toggle("is-reduced-motion", reducedMotion.matches);
      if (carouselToggle) {
        carouselToggle.hidden = reducedMotion.matches;
        carouselToggle.disabled = reducedMotion.matches;
      }
    }

    if (carousel && carouselToggle) {
      carouselToggle.addEventListener("click", function () {
        var isPaused = carousel.classList.toggle("is-paused");
        carouselToggle.setAttribute("aria-pressed", String(isPaused));
        var label = carouselToggle.querySelector("[data-carousel-toggle-label]");
        if (label) label.textContent = isPaused ? "Resume animation" : "Pause animation";
      });
    }
    if (typeof reducedMotion.addEventListener === "function") reducedMotion.addEventListener("change", updateMotionPreference);
    updateMotionPreference();

    document.querySelectorAll("[data-print-resume]").forEach(function (button) {
      button.addEventListener("click", function () { window.print(); });
    });

    updateRochesterTime();
    window.setInterval(updateRochesterTime, 30000);
  });
}());
