import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import type { ProjectInfo } from "@loc-studio/server";
import { StudioProvider, ToastArea, ToastProvider } from "@/components/context";
import type { ClientApi } from "@/lib/client/api";

/** StudioProvider と通知の中で描く。 */
export function renderWithStudio(ui: ReactNode, api: ClientApi, info: ProjectInfo, setInfo: (i: ProjectInfo) => void = () => {}) {
  return render(
    <ToastProvider>
      <StudioProvider value={{ api, project: "/tmp/test", info, setInfo }}>{ui}</StudioProvider>
      <ToastArea />
    </ToastProvider>,
  );
}
