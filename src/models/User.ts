import { Schema, model, Types } from "mongoose";

export type Role =
  | "admin"
  | "manager"
  | "receptionist"
  | "waiter"
  | "kitchen"
  | "rider";

const UserSchema = new Schema(
  {
    outletId: { type: Schema.Types.ObjectId, ref: "Outlet", required: true },
    // When set, this user can switch between any of these outlets.
    outletIds: [{ type: Schema.Types.ObjectId, ref: "Outlet" }],
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ["admin", "manager", "receptionist", "waiter", "kitchen", "rider"] },
    phone: String,
    pin: String,
    rating: { type: Number, default: 4.5 },
    active: { type: Boolean, default: true },
    clockedInAt: Date,
    currentShift: String,
    onBreak: { type: Boolean, default: false },
    hourlyRate: { type: Number, default: 0 },
    hireDate: Date,
  },
  { timestamps: true }
);

UserSchema.methods.toPublic = function () {
  const o = this.toObject({ virtuals: true });
  delete o.passwordHash;
  delete o.pin;
  return o;
};

export const User = model("User", UserSchema);
export type UserId = Types.ObjectId;
