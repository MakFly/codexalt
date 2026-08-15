export const PROFILE_MODES = ["hybrid", "isolated"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

export interface ProfileRecord {
  alias: string;
  label?: string;
  mode: ProfileMode;
  createdAt: string;
}

export interface Registry {
  version: 1;
  active: string | null;
  codexBinary: string | null;
  profiles: Record<string, ProfileRecord>;
}

export const EMPTY_REGISTRY: Registry = {
  version: 1,
  active: null,
  codexBinary: null,
  profiles: {},
};
