import mongoose from "mongoose";
import { env } from "./env";

export async function connectDB(): Promise<string> {
  const uri = env.MONGO_URI;
  if (!uri) {
    throw new Error(
      "MONGO_URI is required. In-memory Mongo fallback is disabled."
    );
  }
  await mongoose.connect(uri);
  mongoose.set("toJSON", {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret: any) => {
      ret.id = ret._id?.toString();
      delete ret._id;
      return ret;
    },
  });
  return uri;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
