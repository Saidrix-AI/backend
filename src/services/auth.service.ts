import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { UserModel } from "../database/models/user.model.js";
import { ApiError } from "../utils/apiError.js";

const BCRYPT_ROUNDS = 10;

export interface AuthResult {
  token: string;
  user: { id: string; name: string; email: string };
}

function signToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

export async function register(name: string, email: string, password: string): Promise<AuthResult> {
  const existing = await UserModel.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw new ApiError(409, "An account with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await UserModel.create({ name, email, passwordHash });

  return {
    token: signToken(user.id, user.email),
    user: { id: user.id, name: user.name, email: user.email },
  };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const user = await UserModel.findOne({ email: email.toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new ApiError(401, "Invalid email or password");
  }

  return {
    token: signToken(user.id, user.email),
    user: { id: user.id, name: user.name, email: user.email },
  };
}
