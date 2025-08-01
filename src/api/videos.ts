import { respondWithJSON } from "./json";
import { rm } from "fs/promises";
import path from "path";

import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { generatePresignedURL, uploadVideoToS3 } from "./s3";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;
  

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof Blob)) {
    throw new BadRequestError("Video file missing");
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      `Video file exceeds the maximum allowed size of 1GB`,
    );
  }
  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type. Only MP4 allowed.");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, file);

  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  const processedFilePath = await processVideoForFastStart(tempFilePath);

  const key = `${aspectRatio}/${videoId}.mp4`;
  await uploadVideoToS3(cfg, key, processedFilePath, "video/mp4");

  video.videoURL = key;
  updateVideo(cfg.db, video);

  await Promise.all([
    rm(tempFilePath, { force: true }),
    rm(`${tempFilePath}.processed.mp4`, { force: true }),
  ]);
  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(
    [
      "ffprobe", 
      "-v", 
      "error", 
      "-select_streams", 
      "v:0", 
      "-show_entries", 
      "stream=width,height", 
      "-of", 
      "json", 
      filePath
    ],
    {
      stdout: "pipe",
      stderr: "pipe"
    }
  );

  const out = new Response(proc.stdout);
  const err = new Response(proc.stderr);
  
  const resOut = await out.text();
  const resErr = await err.text();

  const exitCode = await proc.exited; 
  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${resErr}`);
  }

  const output = JSON.parse(resOut); 
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams were found");
  }

  const { width, height } = output.streams[0];

  return width === Math.floor(16 * (height / 9))
    ? "landscape"
    : height === Math.floor(16 * (width / 9))
      ? "portrait"
      : "other";
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`
  
  const procs = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath, 
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      outputFilePath
    ]
  );

  await procs.exited;

  return outputFilePath; 
}

export function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    return video
  }

  const preSignedURL = generatePresignedURL(cfg, video.videoURL, 5*60); 
  video.videoURL = preSignedURL;
  return video; 
}