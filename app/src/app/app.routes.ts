import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/courses/courses').then((m) => m.Courses),
  },
  {
    path: 'cours/:id',
    loadComponent: () => import('./pages/roster/roster').then((m) => m.Roster),
  },
  {
    path: 'reglages',
    loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings),
  },
  { path: '**', redirectTo: '' },
];
