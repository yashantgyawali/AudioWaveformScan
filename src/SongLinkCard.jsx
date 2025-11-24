import React from "react";

function SongLinkCard({ song, fallbackUrl }) {
  const href = song?.url || fallbackUrl;
  if (!href) return null;
  const thumbnail = song?.thumbnail;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-2xl overflow-hidden shadow-lg hover:shadow-xl transition-shadow relative"
      style={{ textDecoration: "none" }}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt="YouTube thumbnail"
          className="w-full h-48 object-cover"
        />
      ) : (
        <div className="w-full h-48 bg-indigo-200" />
      )}
      <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-3 text-white">
        <div className="w-14 h-14 rounded-full bg-white/85 text-indigo-700 flex items-center justify-center text-2xl font-semibold shadow">
          ▶
        </div>
        <p className="text-sm font-medium tracking-wide">
          Tap to play on YouTube
        </p>
      </div>
    </a>
  );
}

export default SongLinkCard;

