import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import Toast, { createToastTimer } from "./Toast.svelte";

describe("createToastTimer", () => {
  it("expires after the full duration", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createToastTimer(onExpire, 6_000);

    timer.start();
    vi.advanceTimersByTime(5_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("pausing then resuming runs only the remaining time, not the full duration", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createToastTimer(onExpire, 6_000);

    timer.start();
    vi.advanceTimersByTime(4_000);
    timer.pause();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();

    timer.resume();
    vi.advanceTimersByTime(1_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("hover-then-unhover (pause at 3s, resume, arbitrarily long real time apart) dismisses at ~6s of total visible time, not a fresh 6s", () => {
    // Mirrors the component's pause()/resume() wiring: onmouseenter calls pause(), onmouseleave
    // calls resume(). This proves the timer math a correct hover integration depends on. It
    // cannot exercise the attachment-reactivity boundary itself (whether hovering actually calls
    // these without Svelte tearing down and recreating the timer) — Toast.svelte keeps
    // `hovered`/`hidden` as plain, non-`$state` variables specifically so the `{@attach}` never
    // reruns on hover; that wiring is covered by the manual verification checklist.
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createToastTimer(onExpire, 6_000);

    timer.start(); // toast shown at t=0
    vi.advanceTimersByTime(3_000); // hover happens at t=3s (3s of visible time elapsed)
    timer.pause(); // onmouseenter -> pause()
    vi.advanceTimersByTime(60_000); // pointer stays for a long, arbitrary real-time span
    expect(onExpire).not.toHaveBeenCalled();

    timer.resume(); // onmouseleave -> resume()
    vi.advanceTimersByTime(2_999); // remaining 3s of visible time, minus 1ms
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // total visible time now ~6s
    expect(onExpire).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it("a fresh timer for a replacement message restarts at the full duration", () => {
    vi.useFakeTimers();
    const onExpireA = vi.fn();
    const onExpireB = vi.fn();
    const timerA = createToastTimer(onExpireA, 6_000);

    timerA.start();
    vi.advanceTimersByTime(3_000);
    timerA.cancel();

    const timerB = createToastTimer(onExpireB, 6_000);
    timerB.start();
    vi.advanceTimersByTime(5_999);
    expect(onExpireB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpireB).toHaveBeenCalledOnce();
    expect(onExpireA).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("cancel prevents expiry entirely", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timer = createToastTimer(onExpire, 6_000);

    timer.start();
    vi.advanceTimersByTime(3_000);
    timer.cancel();
    vi.advanceTimersByTime(10_000);

    expect(onExpire).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("Toast markup", () => {
  it("renders the message as an alert popover with a dismiss button", () => {
    const { body } = render(Toast, {
      props: { message: "Prompt rejected", ondismiss: () => {} },
    });

    expect(body).toContain('role="alert"');
    expect(body).toContain('popover="manual"');
    expect(body).toContain("Prompt rejected");
    expect(body).toContain('aria-label="Dismiss error"');
    expect(body).not.toContain('aria-label="Copy error"');
  });

  it("renders nothing when there is no message", () => {
    const { body } = render(Toast, { props: { message: "", ondismiss: () => {} } });

    expect(body).not.toContain('role="alert"');
    expect(body).not.toContain("popover");
  });

  it("shows a copy button and clamps the display for a long message", () => {
    const long = "E".repeat(120);
    const { body } = render(Toast, { props: { message: long, ondismiss: () => {} } });

    expect(body).toContain('aria-label="Copy error"');
    expect(body).toContain("line-clamp-4");
  });
});
