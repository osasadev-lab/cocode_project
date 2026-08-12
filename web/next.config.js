/** @type {import('next').NextConfig} */
const nextConfig = {
  // cocode's frontend is pure static HTML/JS served from Firebase
  // Hosting's free tier; all dynamic behavior (sessions, live location)
  // goes through the separate Go backend on Cloud Run via REST/WebSocket,
  // so no Next.js server runtime is needed here.
  output: "export",
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
