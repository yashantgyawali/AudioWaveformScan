import "./App.css";
import { Navigate, Route, Routes } from "react-router-dom";
import UploadScanner from "./UploadScanner";
import WaveformBarcodeV2 from "./WaveformBarcodeV2";

function App() {
  return (
    <Routes>
      <Route path="/" element={<WaveformBarcodeV2 />} />
      <Route path="/scan/upload" element={<UploadScanner />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
