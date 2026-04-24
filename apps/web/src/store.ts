import { create } from "zustand";
import type { ConversationMode } from "@gptlite/shared";

interface AppState {
  activeConversationId: string | null;
  drawerOpen: boolean;
  mode: ConversationMode;
  adminOpen: boolean;
  setActiveConversationId: (id: string | null) => void;
  setDrawerOpen: (open: boolean) => void;
  setMode: (mode: ConversationMode) => void;
  setAdminOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeConversationId: null,
  drawerOpen: false,
  mode: "chat",
  adminOpen: false,
  setActiveConversationId: (activeConversationId) => set({ activeConversationId }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  setMode: (mode) => set({ mode }),
  setAdminOpen: (adminOpen) => set({ adminOpen })
}));
