import { Link } from "react-router";
import { APP } from "../../shared/app";
import { AccountMenu } from "../auth/AccountMenu";
import { SyncDot } from "./SyncDot";

/** Minimal chrome: app name, sync dot, account menu (§11). */
export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-3xl items-center gap-3 px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" className="size-6 rounded" />
          {APP.name}
        </Link>
        <div className="flex-1" />
        <SyncDot />
        <AccountMenu />
      </div>
    </header>
  );
}
