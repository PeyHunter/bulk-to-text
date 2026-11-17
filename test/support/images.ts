import sharp from "sharp";

/** A small real PNG, so the server's image check passes. */
export const tinyPng = (width = 40, height = 20) => sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer();
