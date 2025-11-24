import React, { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { decodeCanvas, urlMap } from "./WaveformBarcodeV2";

function UploadScanner() {
  const canvasRef = useRef(null);
  const [error, setError] = useState("");
  const [decoded, setDecoded] = useState(null);
  const [mappedUrl, setMappedUrl] = useState("");

  const handleUploadImage = (file) => {
    if (!file) return;
    setError("");
    setDecoded(null);
    setMappedUrl("");

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      const scale = Math.min(1280 / img.width, 720 / img.height, 1);
      canvas.width = Math.floor(img.width * scale);
      canvas.height = Math.floor(img.height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);

      const result = decodeCanvas(canvas);
      if (result.error) {
        setError(result.error);
        setDecoded(null);
        setMappedUrl("");
        return;
      }

      setDecoded(result);
      if (result.valid) {
        const url = urlMap.get(result.data);
        if (url) {
          setMappedUrl(url);
          window.open(url, "_blank");
        } else {
          setMappedUrl("");
        }
      }
    };

    img.onerror = () => {
      setError("Failed to load image");
      URL.revokeObjectURL(objectUrl);
    };

    img.src = objectUrl;
  };

  return (
    <div className="min-h-screen flex flex-col">
      <div className="w-full max-w-2xl mx-auto p-4 flex-1 flex flex-col gap-6">
        <div>
          <p className="text-sm text-gray-500 mb-2">
            <Link to="/" className="text-indigo-600 underline">
              ← Back to camera scanner
            </Link>
          </p>
          <h1 className="text-2xl font-bold">Upload barcode image</h1>
          <p className="text-sm text-gray-500">
            Drop a PNG/JPG barcode and we will decode it instantly.
          </p>
        </div>

        <label className="border-2 border-dashed border-gray-300 rounded-2xl p-8 text-center cursor-pointer hover:border-indigo-400 transition-colors">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => handleUploadImage(e.target.files?.[0] || null)}
          />
          <p className="text-lg font-medium mb-1">Choose an image</p>
          <p className="text-sm text-gray-500">
            Supported formats: PNG, JPG, HEIC, GIF
          </p>
        </label>

        <canvas ref={canvasRef} style={{ display: "none" }} />

        {error && <p className="text-sm text-red-500">{error}</p>}

        {decoded && (
          <div
            className={`p-4 rounded-lg border ${
              decoded.valid
                ? "bg-green-50 border-green-200"
                : "bg-yellow-50 border-yellow-200"
            }`}
          >
            <p className="text-sm mb-1">
              {decoded.valid ? "✅ Valid payload" : "⚠️ CRC Error"}
            </p>
            <p className="font-mono text-2xl">{decoded.data}</p>
            {mappedUrl && (
              <a
                href={mappedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline text-sm block mt-2"
              >
                Open: {mappedUrl}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default UploadScanner;

