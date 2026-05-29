"use client";
import React from "react";
import { useAuth, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/app/lib/utils";
import { MenuToggleIcon } from "@/components/ui/menu-toggle-icon";
import { useScroll } from "@/components/ui/use-scroll";
import Image from "next/image";

const publicLinks = [
  { label: "Features", href: "#features" },
  { label: "Pricing", href: "#pricing" },
  { label: "About", href: "#about" },
];

const privateLinks = [
  { label: "Resume Builder", href: "/resume-builder/" },
  { label: "Resume Analyzer", href: "/resume-analyzer/" },
  { label: "Cover Letter", href: "/cover-letter/" },
  { label: "Interviewer", href: "/interviewer/" },
  { label: "Job Listings", href: "/job-listings/" },
  { label: "Leaderboard", href: "/leaderboard/" },
];

function makeHref(path: string): string {
  if (path.startsWith("#")) return path;
  return path;
}

export function Header() {
  const [open, setOpen] = React.useState(false);
  const scrolled = useScroll(80);
  const { isSignedIn } = useAuth();

  const links = isSignedIn ? privateLinks : publicLinks;

  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="relative h-14 md:h-12">
      <header
        className={cn(
          "z-50 border-b border-transparent w-full md:rounded-md md:border md:transition-all md:ease-out",
          scrolled
            ? "fixed inset-x-0 mx-auto max-w-5xl animate-slideDown"
            : "absolute inset-x-0 mx-auto max-w-5xl",
          {
            "bg-background/95 supports-[backdrop-filter]:bg-background/50 border-border backdrop-blur-lg md:shadow":
              scrolled && !open,
            "bg-background/90": open,
          },
        )}
        style={{ animationFillMode: "backwards" }}
      >
        <nav
          className={cn(
            "flex h-14 w-full items-center justify-between px-4 md:h-12 md:transition-all md:ease-out",
            { "md:px-2": scrolled },
          )}
        >
         <a href="/" className="relative flex items-center">
          <span className="font-extrabold text-lg tracking-tight">CareerForge</span>

          {/* spacing so text/navbar doesn't overlap */}
          <div className="w-28" />
        </a>
          <div className="hidden items-center gap-2 md:flex">
            {links.map((link, i) => (
              <a key={i} className={buttonVariants({ variant: "ghost" })} href={makeHref(link.href)}>
                {link.label}
              </a>
            ))}
            {isSignedIn ? (
              <>
                <a className={buttonVariants({ variant: "outline" })} href={makeHref("/profile/")}>
                  Profile
                </a>
                <UserButton
                  appearance={{
                    variables: {
                      colorPrimary: "#57d6ff",
                      colorBackground: "#0b1222",
                      colorInputBackground: "#101a31",
                      colorText: "#f1f5f9",
                      colorTextSecondary: "#94a3b8",
                      colorInputText: "#f1f5f9",
                    },
                    elements: {
                      card: "border: 1px solid rgba(87, 214, 255, 0.25)",
                      headerTitle: "color: #f1f5f9",
                      headerSubtitle: "color: #94a3b8",
                      dividerText: "color: #64748b",
                      footerActionText: "color: #94a3b8",
                      footerActionLink: "color: #57d6ff",
                      formFieldLabel: "color: #cbd5e1",
                      formFieldInput: "color: #f1f5f9",
                      socialButtonsBlockButton: "color: #f1f5f9; border-color: rgba(148,163,184,0.25)",
                      socialButtonsBlockButtonText: "color: #f1f5f9",
                      formButtonPrimary: "background: linear-gradient(135deg, #57d6ff 0%, #7c3aed 100%); color: #071126; border: none",
                      alertText: "color: #f1f5f9",
                      identityPreviewText: "color: #f1f5f9",
                      userPreviewUsername: "color: #f1f5f9",
                      userPreviewIdentifier: "color: #94a3b8",
                      userButtonPopoverCard: "background: #0b1222; border: 1px solid rgba(87, 214, 255, 0.25)",
                      userButtonPopoverActionItem: "color: #f1f5f9",
                      userButtonPopoverActionItemText: "color: #f1f5f9",
                      userButtonPopoverFooter: "color: #94a3b8",
                    },
                  }}
                />
              </>
            ) : (
              <>
                <SignInButton mode="modal" oauthFlow="popup">
                  <Button variant="outline">Sign In</Button>
                </SignInButton>
                <SignUpButton mode="modal" oauthFlow="popup">
                  <Button>Get Started</Button>
                </SignUpButton>
              </>
            )}
          </div>
          <Button size="icon" variant="outline" onClick={() => setOpen(!open)} className="md:hidden">
            <MenuToggleIcon open={open} className="size-5" duration={300} />
          </Button>
        </nav>

        <div
          className={cn(
            "bg-background/90 fixed top-14 right-0 bottom-0 left-0 z-50 flex flex-col overflow-hidden border-y md:hidden",
            open ? "block" : "hidden",
          )}
        >
          <div
            data-slot={open ? "open" : "closed"}
            className={cn(
              "data-[slot=open]:animate-in data-[slot=open]:zoom-in-95 data-[slot=closed]:animate-out data-[slot=closed]:zoom-out-95 ease-out flex h-full w-full flex-col justify-between gap-y-2 p-4",
            )}
          >
            <div className="grid gap-y-2">
              {links.map((link) => (
                <a
                  key={link.label}
                  className={buttonVariants({ variant: "ghost", className: "justify-start" })}
                  href={makeHref(link.href)}
                >
                  {link.label}
                </a>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              {isSignedIn ? (
                <a className={buttonVariants({ variant: "outline", className: "w-full" })} href={makeHref("/profile/")}>
                  Profile
                </a>
              ) : (
                <>
                  <SignInButton mode="modal" oauthFlow="popup">
                    <Button variant="outline" className="w-full">Sign In</Button>
                  </SignInButton>
                  <SignUpButton mode="modal" oauthFlow="popup">
                    <Button className="w-full">Get Started</Button>
                  </SignUpButton>
                </>
              )}
            </div>
          </div>
        </div>
      </header>
    </div>
  );
}
