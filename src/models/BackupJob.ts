import { Schema, model } from "mongoose";

const BackupJobSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true, index: true },
    triggeredBy: { type: Schema.Types.ObjectId, ref: "User" },
    triggeredByName: String,
    status: { type: String, enum: ["running", "done", "failed"], default: "running" },
    collections: { type: [String], default: [] },
    recordCount: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
    error: String,
    startedAt: { type: Date, default: Date.now },
    finishedAt: Date,
  },
  { timestamps: true }
);

export const BackupJob = model("BackupJob", BackupJobSchema);
