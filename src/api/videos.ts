import { respondWithJSON } from "./json";

import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { mediaTypeToExt } from "./assets";
import { randomBytes } from 'node:crypto';

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

  const mediaType = file.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Invalid file type. Only MP4 allowed.");
  }

  const videoData = await file.arrayBuffer();
  const extension = mediaTypeToExt(mediaType);
  const tempFile = Bun.file(`/tmp/tmp-${videoId}.${extension}`);
  await Bun.write(tempFile, videoData);

  const fileKey = `${randomBytes(32).toHex()}.${extension}`
  const body = await tempFile.arrayBuffer();
  const contentType = tempFile.type; 
  const s3File = cfg.s3Client.file(fileKey);
  await s3File.write(Buffer.from(body), {
    type: contentType
  });
  
  await tempFile.delete();

  const urlPath = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileKey}`;
  video.videoURL = urlPath; 
  updateVideo(cfg.db, video);

  return respondWithJSON(200, null);
}
