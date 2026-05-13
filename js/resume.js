(function () {
  function updateLocalTime() {
    document.querySelectorAll("#local-time, #mobile-local-time").forEach(function (element) {
      var now = new Date();
      element.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    });
  }

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

  document.addEventListener("DOMContentLoaded", function () {
    var mobileMenu = document.getElementById("mobile-menu");
    var mobileMenuButton = document.getElementById("mobile-menu-button");
    var mobileMenuClose = document.getElementById("mobile-menu-close");

    function openMobileMenu() {
      if (!mobileMenu) return;
      mobileMenu.classList.remove("hidden");
      document.body.style.overflow = "hidden";
    }

    function closeMobileMenu() {
      if (!mobileMenu) return;
      mobileMenu.classList.add("hidden");
      document.body.style.overflow = "";
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
        if (window.innerWidth < 768) closeMobileMenu();
      });
    });

    updateLocalTime();
    window.setInterval(updateLocalTime, 60000);
  });
})();
