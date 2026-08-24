(function restoreThemeBeforePaint() {
  var supported = { kodra: true, mist: true, ember: true };
  var id = "kodra";
  try {
    var stored = localStorage.getItem("kodra-theme");
    if (supported[stored]) id = stored;
  } catch (_) {}
  document.documentElement.dataset.theme = id;
}());
