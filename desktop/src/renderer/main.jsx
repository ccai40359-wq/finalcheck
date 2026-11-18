import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import SnapshotPage, { snapshotParams } from './SnapshotPage.jsx';
import './styles.css';

// 隐藏截图窗口（capture_screenshot）走 #fc-snapshot?…，只渲染要截的那一页/那一帧，不起整个应用
const snap = snapshotParams();

createRoot(document.getElementById('root')).render(
  snap ? <SnapshotPage params={snap} /> : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
);
