const favicons = [
    "/favicon.ico",
    "/favicons/Cargo.png",
    "/favicons/photo_2026-04-27_17-46-43.png",
    "/favicons/photo_2026-06-12_21-15-01.png",
    "/favicons/photo_2026-09-27_17-56-16.png",
    "/favicons/photo_2026-10-30_13-15-19.png",
    "/favicons/photo_2026-11-04_18-09-31.png",
];
const previousFavicon = sessionStorage.getItem("favicon");
const choices = favicons.filter((favicon) => favicon !== previousFavicon);
const favicon = choices[Math.floor(Math.random() * choices.length)];
document.querySelector('link[rel="icon"]').href = favicon;
sessionStorage.setItem("favicon", favicon);
