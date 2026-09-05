import { Link, useNavigate } from "react-router";
import { LogOut, User, LogIn } from "lucide-react";
import { signOut, useSession } from "./client";
import { sync } from "../store/sync";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";

export function AccountMenu() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  if (isPending) return <span className="size-8" />;
  if (!session) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link to="/sign-in">
          <LogIn /> Sign in
        </Link>
      </Button>
    );
  }

  const initial = (session.user.name || session.user.email || "?").slice(0, 1).toUpperCase();

  const onSignOut = async () => {
    // Push anything pending first; local data stays on the device (§8).
    await sync.flush().catch(() => undefined);
    await signOut();
    navigate("/");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60" aria-label="Account menu">
          {session.user.image ? <img src={session.user.image} alt="" className="size-8 rounded-full" /> : initial}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="truncate">{session.user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/account")}>
          <User /> Account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void onSignOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
