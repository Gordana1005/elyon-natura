import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import i18n from '@/i18n';
import type { CallScriptsForCall, TargetedScript } from '@/lib/callScriptsTypes';
import prediction from './__fixtures__/forCall.prediction.sample.json';
import lead from './__fixtures__/forCall.lead.sample.json';
import { ScriptBody } from './ScriptBody';
import { QuickAnswers } from './QuickAnswers';

const P = prediction as unknown as CallScriptsForCall;
const L = lead as unknown as CallScriptsForCall;

beforeAll(async () => { await i18n.changeLanguage('mk'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const chips = () => within(screen.getByTestId('section-chips')).getAllByRole('button').map((b) => b.textContent);
const section = (id: string) => document.querySelector(`[data-section="${id}"]`) as HTMLElement;

describe('ScriptBody — sections, chips, variables', () => {
  it('renders the sections in order with the sticky chips (fixed headings · custom title · Брзи одговори (n))', () => {
    render(<ScriptBody script={P.best!} vars={P.vars} lang="mk" />);
    expect(chips()).toEqual(['Отворање', 'Презентација', 'Приговори', 'Затворање', 'Подарок', 'Брзи одговори (2)']);
    const order = [...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'));
    expect(order).toEqual(['opening', 'pitch', 'objections', 'closing', 'custom-gift01']);
    expect(screen.getByText('Клиенти кои купиле Простатол пред околу 3 недели.')).toBeInTheDocument();
    expect(screen.getByTestId('quick-answers')).toHaveTextContent('Брзи одговори');
  });

  it('fills the variables from the call; a missing value is an amber chip with the variable label', () => {
    render(<ScriptBody script={P.best!} vars={P.vars} lang="mk" />);
    const opening = section('opening');
    expect(opening).toHaveTextContent('Добар ден Марија, јас сум Ана од Натура Терапи.');
    expect(opening).toHaveTextContent('Prostatol Complex што го нарачавте пред 3 недели');
    // {{price}} = 26 € × 61,5 → денари, the frozen peg
    expect(section('objections')).toHaveTextContent('2+2 за 1.599 ден');
    // {{city}} is null in the fixture → the amber "Град" chip, never the raw token
    const missing = within(section('closing')).getByTestId('var-missing');
    expect(missing).toHaveTextContent('Град');
    expect(missing).toHaveAttribute('data-var', 'city');
    expect(section('closing')).not.toHaveTextContent('{{city}}');
  });

  it('vars = null (the editor preview): every variable is a neutral chip with its label', () => {
    render(<ScriptBody script={P.best!} vars={null} lang="mk" />);
    const vars = within(section('opening')).getAllByTestId('var-chip').map((c) => c.textContent);
    expect(vars).toEqual(['Име', 'Твоето име', 'Последен производ', 'Пред колку време купил']);
    expect(screen.queryByTestId('var-missing')).toBeNull();
  });

  it('never renders HTML from a script — tags stay literal text', () => {
    const s: TargetedScript = {
      ...P.best!,
      sections: [{ id: 'pitch', key: 'pitch', text: '<b>Важно</b> <img src=x onerror="alert(1)"> {{first_name}}' }],
      helpers: [],
    };
    const { container } = render(<ScriptBody script={s} vars={P.vars} lang="mk" />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(section('pitch')).toHaveTextContent('<b>Важно</b> <img src=x onerror="alert(1)"> Марија');
  });

  it('Albanian: the sq text per section, Macedonian (marked "МК") where sq is missing', () => {
    render(<ScriptBody script={P.best!} vars={P.vars} lang="sq" />);
    expect(section('opening')).toHaveTextContent('Mirëdita Марија, jam Ана nga Natura Therapy');
    expect(section('opening')).toHaveTextContent('para 3 javësh'); // {{since_purchase}} in Albanian
    expect(within(section('opening')).queryByTestId('fallback-mk')).toBeNull();
    // objections / closing / the custom section have no sq text → Macedonian + the mark
    expect(within(section('objections')).getByTestId('fallback-mk')).toHaveTextContent('МК');
    expect(section('objections')).toHaveTextContent('„Скапо ми е“');
  });

  it('a chip scrolls its section into view and lights up', () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    render(<ScriptBody script={P.best!} vars={P.vars} lang="mk" />);
    const btn = within(screen.getByTestId('section-chips')).getByRole('button', { name: /Приговори/ });
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.instances[0]).toBe(section('objections'));
    expect(btn).toHaveAttribute('aria-current', 'true');
  });

  it('one section and no quick answers → no chips row; empty sections are skipped', () => {
    const s: TargetedScript = {
      ...L.best!,
      sections: [{ id: 'opening', key: 'opening', text: 'Здраво {{first_name}}' }, { id: 'pitch', key: 'pitch', text: '   ' }],
    };
    render(<ScriptBody script={s} vars={L.vars} lang="mk" />);
    expect(screen.queryByTestId('section-chips')).toBeNull();
    expect(document.querySelectorAll('[data-section]')).toHaveLength(1);
    expect(section('opening')).toHaveTextContent('Здраво Петар');
  });

  it('a script with no text says so', () => {
    render(<ScriptBody script={{ ...L.best!, sections: [] }} vars={L.vars} lang="mk" />);
    expect(screen.getByText('Скриптата сè уште нема текст.')).toBeInTheDocument();
  });
});

describe('QuickAnswers', () => {
  const helpers = [
    { title: 'Цена', content: 'Една кутија {{price}}', category: 'price' },
    { title: 'Достава', content: 'MEX, 1–2 дена', category: null },
    { title: 'Плаќање', content: 'При подигање', category: null },
    { title: 'Дијабетол', content: 'За шеќер', category: null },
  ];

  it('one open at a time, the values filled; search (Latin or Cyrillic) from 4 answers', () => {
    render(<QuickAnswers helpers={helpers} vars={P.vars} lang="mk" />);
    fireEvent.click(screen.getByRole('button', { name: /Цена/ }));
    expect(screen.getByText(/Една кутија/)).toHaveTextContent('Една кутија 1.599 ден');
    fireEvent.click(screen.getByRole('button', { name: /Достава/ }));
    expect(screen.queryByText(/Една кутија/)).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'dijabetol' } });
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Дијабетол']);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('Нема совпаѓања.')).toBeInTheDocument();
  });

  it('no search box for 3 answers or fewer; legacy keeps today\'s "Помошници" and plain text', () => {
    render(<QuickAnswers helpers={helpers.slice(0, 3)} legacy />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('quick-answers')).toHaveTextContent('Помошници');
    fireEvent.click(screen.getByRole('button', { name: /Цена/ }));
    expect(screen.getByText('Една кутија {{price}}')).toBeInTheDocument();
  });
});
