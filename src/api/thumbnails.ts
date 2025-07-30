import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

const MAX_UPLOAD_SIZE = 10 * Math.pow(2, 20); // Since in MB. 

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const data = await req.formData();
  const thumbnail = data.get("thumbnail"); 

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Image data is not a file.");
  }

  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Image size too big.");
  }

  const mediaType = thumbnail.type;
  const thumbnailData = await thumbnail.arrayBuffer();
  const videoMetaData = getVideo(cfg.db, videoId);
  const encodedThumbnailData = Buffer.from(thumbnailData).toString("base64");
  const dataURL = `data:${mediaType};base64,${encodedThumbnailData}`;

  if (!videoMetaData) {
    throw new NotFoundError("Vidoe does not exist");
  }

  if (videoMetaData.userID != userID) {
    throw new UserForbiddenError("Not the owner of the video");
  }

  videoMetaData.thumbnailURL = dataURL; 
  updateVideo(cfg.db, videoMetaData); 

  return respondWithJSON(200, videoMetaData);
}
