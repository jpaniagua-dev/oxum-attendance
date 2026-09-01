import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SettingsService } from './settings.service';

/**
 * The lock on the class list.
 *
 * It guards the screen, not the button that opens it: a student can leave a
 * class by swiping back, pressing nothing at all. What these check is that the
 * only way to `unlocked` is the right code, and that opening a class shuts it
 * again — because that is the moment the phone leaves the teacher's hands.
 */
describe('SettingsService — the class-list lock', () => {
  let settings: SettingsService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    settings = TestBed.inject(SettingsService);
  });

  it('is open while no code is set: there is nothing to ask for', () => {
    expect(settings.hasPin()).toBe(false);
    expect(settings.unlocked()).toBe(true);
  });

  it('closes as soon as a code exists', () => {
    settings.save({ pin: '1234' });
    settings.lock();
    expect(settings.unlocked()).toBe(false);
  });

  it('does not lock the screen the code was typed on', () => {
    settings.save({ pin: '1234' });
    expect(settings.unlocked()).toBe(true);
  });

  it('opens on the right code and stays shut on a wrong one', () => {
    settings.save({ pin: '1234' });
    settings.lock();

    expect(settings.unlock('9999')).toBe(false);
    expect(settings.unlocked()).toBe(false);

    expect(settings.unlock('1234')).toBe(true);
    expect(settings.unlocked()).toBe(true);
  });

  it('shuts again on the way into a class', () => {
    settings.save({ pin: '1234' });
    settings.unlock('1234');
    settings.lock();
    expect(settings.unlocked()).toBe(false);
  });

  it('checking the code grants nothing on its own', () => {
    settings.save({ pin: '1234' });
    settings.lock();

    expect(settings.matches('1234')).toBe(true);
    expect(settings.unlocked()).toBe(false);
  });
});
