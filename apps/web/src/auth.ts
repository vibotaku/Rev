import { useQuery } from "@tanstack/react-query";
import type { Me } from "@rev/shared";
import { api, ApiError } from "./api";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/api/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

/** The signed-in human. Only call below the auth gate in Layout. */
export function useUser() {
  const { data } = useMe();
  if (!data) throw new Error("useUser called outside the auth gate");
  return data.user;
}
