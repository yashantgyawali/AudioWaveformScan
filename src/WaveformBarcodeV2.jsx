import React, { useState, useRef, useEffect, useCallback } from "react";

const BAR_WIDTH = 24;
const SPACING = 4;
const UNIT_HEIGHT = 22;
const PADDING = 30;
const CANVAS_HEIGHT = 280;
const NUM_BARS = 23;

const GRAY_ENCODE = [0, 1, 3, 2, 6, 7, 5, 4];
const GRAY_DECODE = [0, 1, 3, 2, 7, 6, 4, 5];
const BAR_THEME = {
  background: "#504B81",
  primaryBar: "#F6ECFF",
  referenceBar: "#C7B1FF",
  frame: "#3F3A66",
};

const crc8 = (data) => {
  let crc = 0;
  for (let byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) crc = ((crc << 1) ^ 0x07) & 0xff;
      else crc = (crc << 1) & 0xff;
    }
  }
  return crc;
};

const numToBytes = (num, len) => {
  const bytes = [];
  for (let i = len - 1; i >= 0; i--) bytes.push((num >> (i * 8)) & 0xff);
  return bytes;
};

const MAX_40BIT = 0xffffffffff;

const encodeToHeights = (mediaRef) => {
  const num = Number.parseInt(mediaRef, 10);
  if (Number.isNaN(num) || num < 0 || num > MAX_40BIT) return null;
  const bytes = numToBytes(num, 5);
  const checksum = crc8(bytes);
  const combined = (BigInt(num) << 8n) | BigInt(checksum);
  const dataHeights = [];
  for (let i = 15; i >= 0; i--) {
    const bits = Number((combined >> BigInt(i * 3)) & 7n);
    dataHeights.push(GRAY_ENCODE[bits]);
  }
  const permuted = [];
  for (let i = 0; i < 16; i++) permuted.push(dataHeights[(i * 7) % 16]);
  const heights = [0];
  for (let i = 0; i < 10; i++) heights.push(permuted[i] ?? 0);
  heights.push(7);
  for (let i = 10; i < 20; i++) heights.push(permuted[i] ?? 0);
  heights.push(0);
  return heights;
};

const decodeFromHeights = (heights) => {
  if (heights.length !== NUM_BARS) return { error: "Invalid bar count" };
  if (heights[0] > 1 || heights[NUM_BARS - 1] > 1)
    return { error: "Invalid start/end markers" };
  if (heights[11] < 6) return { error: "Invalid center reference bar" };
  const dataHeights = [];
  for (let i = 1; i <= 10; i++) dataHeights.push(heights[i]);
  for (let i = 12; i <= 21; i++) dataHeights.push(heights[i]);
  const unpermuted = new Array(16);
  for (let i = 0; i < 16; i++) unpermuted[(i * 7) % 16] = dataHeights[i];
  let combined = 0n;
  for (let i = 0; i < 16; i++) {
    const grayVal = Math.min(7, Math.max(0, Math.round(unpermuted[i])));
    const bits = GRAY_DECODE[grayVal];
    combined = (combined << 3n) | BigInt(bits);
  }
  const checksum = Number(combined & 0xffn);
  const data = Number(combined >> 8n);
  const bytes = numToBytes(data, 5);
  const calculatedCrc = crc8(bytes);
  if (calculatedCrc !== checksum) return { error: `CRC mismatch`, data };
  return { data, valid: true };
};

const urlMap = new Map();

function WaveformBarcodeV2() {
  const [mode, setMode] = useState("generate");
  const [mediaRef, setMediaRef] = useState("1234567890");
  const [heights, setHeights] = useState([]);
  const [decoded, setDecoded] = useState(null);
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const scanCanvasRef = useRef(null);
  const [scanning, setScanning] = useState(false);
  const [scanMethod, setScanMethod] = useState("camera");
  const [urlInput, setUrlInput] = useState("");
  const [mappedId, setMappedId] = useState("");
  const [mappedUrl, setMappedUrl] = useState("");
  const [cameraReady, setCameraReady] = useState(false);
  const streamRef = useRef(null);

  const drawRoundedRect = (ctx, x, y, w, h, r) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  };

  const drawHeights = useCallback((result) => {
    if (!result || !canvasRef.current) return;
    setHeights(result);
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const totalWidth =
      (BAR_WIDTH + SPACING) * result.length - SPACING + PADDING * 2;
    canvas.width = totalWidth;
    canvas.height = CANVAS_HEIGHT;
    ctx.fillStyle = BAR_THEME.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const centerY = canvas.height / 2;
    let x = PADDING;
    result.forEach((height, i) => {
      const barHeight = (height + 1) * UNIT_HEIGHT;
      const y = centerY - barHeight / 2;
      const isRef = i === 0 || i === 11 || i === result.length - 1;
      ctx.fillStyle = isRef ? BAR_THEME.referenceBar : BAR_THEME.primaryBar;
      drawRoundedRect(ctx, x, y, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
      x += BAR_WIDTH + SPACING;
    });
  }, []);

  const generateBarcode = useCallback(() => {
    const result = encodeToHeights(mediaRef);
    if (!result) {
      setError(`Enter a number between 0 and ${MAX_40BIT}`);
      return;
    }
    setError("");
    drawHeights(result);
  }, [mediaRef, drawHeights]);

  useEffect(() => {
    generateBarcode();
  }, []);

  const stopScanning = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
    setCameraReady(false);
  }, []);

  const startScanning = async () => {
    setError("");
    setDecoded(null);
    setCameraReady(false);

    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;
      setScanning(true);

      // IMPORTANT: Set srcObject AFTER state update so video element exists
      setTimeout(() => {
        const video = videoRef.current;
        if (video && stream) {
          video.srcObject = stream;
        }
      }, 50);
    } catch (err) {
      console.error("Camera error:", err);
      setError(`Camera error: ${err.message || "Unknown"}. Check permissions.`);
      setScanning(false);
    }
  };

  // Handle video element events
  const handleVideoCanPlay = () => {
    const video = videoRef.current;
    if (video) {
      video
        .play()
        .then(() => {
          setCameraReady(true);
        })
        .catch((e) => {
          console.warn("Play failed:", e);
          setError("Video play failed. Try clicking the video area.");
        });
    }
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const handleEncodeUrl = () => {
    if (!urlInput.trim()) {
      setError("Enter a URL to encode");
      return;
    }
    const url = urlInput.trim();
    const id = Math.floor(Math.random() * 1e10);
    urlMap.set(id, url);
    setMappedId(String(id));
    setMediaRef(String(id));
    const h = encodeToHeights(String(id));
    if (h) {
      drawHeights(h);
      setError("");
    }
  };

  const decodeCanvas = (canvas) => {
    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const getBrightness = (x, y) => {
      if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return 255;
      const i = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
      return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };

    const sampleStepX = Math.max(1, Math.floor(canvas.width / 80));
    const sampleStepY = Math.max(1, Math.floor(canvas.height / 80));
    const samples = [];
    for (let y = 0; y < canvas.height; y += sampleStepY) {
      for (let x = 0; x < canvas.width; x += sampleStepX) {
        samples.push(getBrightness(x, y));
      }
    }

    if (samples.length === 0) return { error: "Empty image" };
    const sortedSamples = [...samples].sort((a, b) => a - b);
    const backgroundBrightness =
      sortedSamples[Math.floor(sortedSamples.length / 2)];
    const minBrightness = sortedSamples[0];
    const maxBrightness = sortedSamples[sortedSamples.length - 1];
    const lightDiff = maxBrightness - backgroundBrightness;
    const darkDiff = backgroundBrightness - minBrightness;
    const detectLightBars = lightDiff > darkDiff;
    const contrast = detectLightBars ? lightDiff : darkDiff;
    if (contrast < 10)
      return { error: "Barcode contrast too low to detect" };
    const thresholdBase = detectLightBars
      ? backgroundBrightness + contrast * 0.45
      : backgroundBrightness - contrast * 0.45;
    const threshold = Math.max(0, Math.min(255, thresholdBase));
    const isBarPixel = (x, y) => {
      const brightness = getBrightness(x, y);
      return detectLightBars
        ? brightness >= threshold
        : brightness <= threshold;
    };
    const scanLines = [0.4, 0.45, 0.5, 0.55, 0.6].map((r) =>
      Math.floor(canvas.height * r)
    );
    let bestBars = [];
    for (const centerY of scanLines) {
      const bars = [];
      let inBar = false,
        barStart = 0;
      for (let x = 0; x < canvas.width; x++) {
        const inWave = isBarPixel(x, centerY);
        if (inWave && !inBar) {
          inBar = true;
          barStart = x;
        } else if (!inWave && inBar) {
          inBar = false;
          const barWidth = x - barStart;
          if (barWidth >= 8) {
            const centerX = barStart + barWidth / 2;
            let topY = centerY,
              bottomY = centerY;
            while (topY > 0 && isBarPixel(centerX, topY - 1)) topY--;
            while (
              bottomY < canvas.height - 1 &&
              isBarPixel(centerX, bottomY + 1)
            )
              bottomY++;
            bars.push({ centerX, height: bottomY - topY + 1 });
          }
        }
      }
      if (bars.length > bestBars.length) bestBars = bars;
    }
    if (bestBars.length < 15)
      return { error: `Found ${bestBars.length} bars, need 15+` };
    const maxHeight = Math.max(...bestBars.map((b) => b.height));
    const unitH = maxHeight / 8;
    const detectedHeights = bestBars.map((bar) => {
      const level = Math.round(bar.height / unitH) - 1;
      return Math.max(0, Math.min(7, level));
    });
    while (detectedHeights.length < NUM_BARS) detectedHeights.push(0);
    return decodeFromHeights(detectedHeights.slice(0, NUM_BARS));
  };

  const captureAndDecode = () => {
    const video = videoRef.current;
    const canvas = scanCanvasRef.current;
    if (!video || !canvas) return setError("Video not ready");
    if (!video.videoWidth || !video.videoHeight)
      return setError("Camera not ready - wait a moment");

    const ctx = canvas.getContext("2d");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const result = decodeCanvas(canvas);
    if (result.error) {
      setError(result.error);
      setDecoded(null);
    } else {
      setDecoded(result);
      setError("");
      if (result.valid) {
        const url = urlMap.get(result.data);
        if (url) setMappedUrl(url);
        stopScanning();
      }
    }
  };

  const handleUploadImage = (file) => {
    if (!file) return;
    const canvas = scanCanvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1280 / img.width, 720 / img.height, 1);
      canvas.width = Math.floor(img.width * scale);
      canvas.height = Math.floor(img.height * scale);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const result = decodeCanvas(canvas);
      if (result.error) {
        setError(result.error);
        setDecoded(null);
      } else {
        setDecoded(result);
        setError("");
        if (result.valid) {
          const url = urlMap.get(result.data);
          if (url) {
            setMappedUrl(url);
            window.open(url, "_blank");
          }
        }
      }
    };
    img.onerror = () => setError("Failed to load image");
    img.src = URL.createObjectURL(file);
  };

  const downloadBarcode = () => {
    const link = document.createElement("a");
    link.download = `waveform-${mediaRef}.png`;
    link.href = canvasRef.current.toDataURL("image/png");
    link.click();
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold mb-1 text-center">
        Waveform Barcode v2
      </h1>
      <p className="text-sm text-gray-500 text-center mb-4">
        With CRC, Gray Code & Permutation
      </p>

      <div className="flex gap-2 mb-4 justify-center">
        {["generate", "scan", "info"].map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              if (m !== "scan") stopScanning();
            }}
            className={`px-4 py-2 rounded-lg font-medium capitalize ${
              mode === m ? "bg-black text-white" : "bg-gray-200"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "generate" && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              YouTube URL:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                className="flex-1 p-3 border rounded-lg"
                placeholder="https://youtube.com/watch?v=..."
              />
              <button
                onClick={handleEncodeUrl}
                className="px-4 py-3 bg-indigo-600 text-white rounded-lg"
              >
                Encode
              </button>
            </div>
            {mappedId && (
              <p className="text-xs text-gray-600 mt-1">
                Saved ID: <span className="font-mono">{mappedId}</span>
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Or enter ID directly:
            </label>
            <input
              type="text"
              value={mediaRef}
              onChange={(e) =>
                setMediaRef(e.target.value.replace(/[^0-9]/g, "").slice(0, 12))
              }
              className="w-full p-3 border rounded-lg font-mono text-lg"
            />
            <button
              onClick={generateBarcode}
              className="mt-2 px-4 py-2 bg-gray-800 text-white rounded"
            >
              Generate
            </button>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div
            className="p-4 rounded-lg flex justify-center"
            style={{ backgroundColor: BAR_THEME.frame }}
          >
            <canvas ref={canvasRef} className="max-w-full" />
          </div>
          <button
            onClick={downloadBarcode}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium"
          >
            Download PNG
          </button>
          <div className="text-xs text-gray-600 bg-gray-50 p-3 rounded font-mono">
            <p>
              <strong>Heights:</strong> [{heights.join(", ")}]
            </p>
          </div>
        </div>
      )}

      {mode === "scan" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <button
              onClick={() => {
                setScanMethod("camera");
                stopScanning();
              }}
              className={`flex-1 py-2 rounded ${
                scanMethod === "camera" ? "bg-black text-white" : "bg-gray-200"
              }`}
            >
              Camera
            </button>
            <button
              onClick={() => {
                setScanMethod("upload");
                stopScanning();
              }}
              className={`flex-1 py-2 rounded ${
                scanMethod === "upload" ? "bg-black text-white" : "bg-gray-200"
              }`}
            >
              Upload
            </button>
          </div>

          {scanMethod === "camera" && (
            <>
              {!scanning ? (
                <button
                  onClick={startScanning}
                  className="w-full py-3 bg-green-600 text-white rounded-lg font-medium"
                >
                  Start Camera
                </button>
              ) : (
                <div className="space-y-3">
                  <div
                    className="relative bg-gray-900 rounded-lg overflow-hidden"
                    style={{ minHeight: 300 }}
                  >
                    {/* Video element - visible, not hidden */}
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      onCanPlay={handleVideoCanPlay}
                      style={{
                        width: "100%",
                        height: "auto",
                        minHeight: 300,
                        display: "block",
                        objectFit: "cover",
                      }}
                    />

                    {/* Loading overlay */}
                    {!cameraReady && (
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                        <div className="text-white text-center">
                          <div className="animate-spin w-8 h-8 border-4 border-white border-t-transparent rounded-full mx-auto mb-2"></div>
                          <p>Starting camera...</p>
                        </div>
                      </div>
                    )}

                    {/* Scan guide overlay */}
                    {cameraReady && (
                      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <div
                          className="border-2 border-green-400 w-4/5 h-20 rounded-lg shadow-lg"
                          style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.3)" }}
                        ></div>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={captureAndDecode}
                      disabled={!cameraReady}
                      className={`flex-1 py-3 rounded-lg text-white ${
                        cameraReady ? "bg-blue-600" : "bg-blue-300"
                      }`}
                    >
                      {cameraReady ? "Capture & Decode" : "Waiting..."}
                    </button>
                    <button
                      onClick={stopScanning}
                      className="px-4 py-3 bg-red-600 text-white rounded-lg"
                    >
                      Stop
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {scanMethod === "upload" && (
            <div className="space-y-2">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => handleUploadImage(e.target.files?.[0])}
                className="w-full p-2 border rounded"
              />
              <p className="text-xs text-gray-500">
                Upload a barcode image to decode
              </p>
            </div>
          )}

          <canvas ref={scanCanvasRef} style={{ display: "none" }} />

          {error && <p className="text-red-500 text-sm">{error}</p>}

          {decoded && (
            <div
              className={`p-4 rounded-lg border ${
                decoded.valid
                  ? "bg-green-50 border-green-200"
                  : "bg-yellow-50 border-yellow-200"
              }`}
            >
              <p className="text-sm mb-1">
                {decoded.valid ? "✅ Valid!" : "⚠️ CRC Error"}
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
      )}

      {mode === "info" && (
        <div className="space-y-4 text-sm">
          <div className="bg-blue-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">🔒 CRC-8 Checksum</h3>
            <p>
              Validates data integrity. If any bar is misread, the CRC fails.
            </p>
          </div>
          <div className="bg-purple-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">📊 Gray Code</h3>
            <p>
              Adjacent heights differ by 1 bit. Misreading level 3 as 4 causes
              only 1 bit error.
            </p>
          </div>
          <div className="bg-green-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">🔀 Permutation</h3>
            <p>Data shuffled so adjacent bits aren't in adjacent bars.</p>
          </div>
          <div className="bg-orange-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">📍 Reference Bars</h3>
            <p>
              Positions 1, 12, 23 have fixed heights (0, 7, 0) for calibration.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default WaveformBarcodeV2;
