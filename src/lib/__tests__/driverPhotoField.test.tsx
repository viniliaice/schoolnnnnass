// Render tests for the DriverPhotoField (Take Photo | Upload Photo).
//
// Pins the required UI: both capture actions must exist, the empty state must
// show the "No driver photo" placeholder, and the two inputs must keep their
// camera (`capture="environment"`) and gallery (`accept="image/*"`) modes so
// camera capture works on Android while a plain upload stays available.
//
// Convention follows gateGroupHeader.test.tsx — renderToStaticMarkup, no
// jsdom or testing-library (the component only touches the DOM in event
// handlers and effects, which never run under server rendering).

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { DriverPhotoField } from '../../components/photo/DriverPhotoField';

describe('DriverPhotoField', () => {
  it('shows the no-photo placeholder plus both Take Photo and Upload Photo actions', () => {
    const html = renderToStaticMarkup(<DriverPhotoField onChange={() => {}} />);

    expect(html).toContain('No driver photo');
    expect(html).toContain('Take Photo');
    expect(html).toContain('Upload Photo');
    // Camera capture keeps the native `capture` attribute (Android launches
    // the camera); upload is a plain image picker.
    expect(html).toContain('capture="environment"');
    expect(html).toContain('accept="image/*"');
    // Empty state shows no preview image.
    expect(html).not.toContain('Driver photo preview');
  });

  it('previews an existing photo when editing (initialPhotoUrl)', () => {
    const url = 'https://x/signed/pickup-1.jpg?token=abc';
    const html = renderToStaticMarkup(<DriverPhotoField onChange={() => {}} initialPhotoUrl={url} />);

    expect(html).toContain('Driver photo preview');
    expect(html).toContain(url);
    expect(html).not.toContain('No driver photo');
    // A photo that is already set can be removed/replaced.
    expect(html).toContain('Remove');
  });
});
