import { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet, Text, TextInput, Pressable, View, FlatList, Keyboard, Alert,
  ScrollView, Switch, AppState, LayoutAnimation,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as Notifications from 'expo-notifications';
import * as Calendar from 'expo-calendar/legacy';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import Svg, { Path, Circle } from 'react-native-svg';
import {
  useFonts, Nunito_500Medium, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black,
} from '@expo-google-fonts/nunito';

const APP_NAME = 'Тук-тук';

// ---------- Кольори і шрифти ----------

const C = {
  green: '#1F7A4D',
  greenDark: '#145A38',
  mint: '#D9F2E3',
  mintLight: '#EEF5EF',
  cream: '#F4F1E8',
  creamField: '#FBFAF5',
  line: '#E3E0D5',
  white: '#FFFFFF',
  ink: '#1E2A22',
  text: '#3E4A42',
  muted: '#5E6B62',
  honey: '#F4B860',
  honeyLight: '#FCE9C8',
  honeyText: '#7A4A06',
  red: '#B42318',
  blue: '#3A5BA9',
  blueLight: '#E7ECF7',
};

const F = {
  regular: 'Nunito_500Medium',
  bold: 'Nunito_700Bold',
  extra: 'Nunito_800ExtraBold',
  black: 'Nunito_900Black',
};

// ---------- База ----------

const db = SQLite.openDatabaseSync('tasks.db');

db.execSync(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calendar_event_id TEXT NOT NULL,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    reminder_min INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );
`);

// Міграція: додаємо колонку deadline, якщо її ще немає
const taskColumns = db.getAllSync('PRAGMA table_info(tasks)');
if (!taskColumns.some((c) => c.name === 'deadline')) {
  db.execSync('ALTER TABLE tasks ADD COLUMN deadline TEXT');
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const CHANNEL_ID = 'reminders';
const CATEGORY_ID = 'task';
const UNDO_SECONDS = 6;
const SNOOZE_MIN = 15;
const SNOOZE_PREFIX = 'snooze-';
const MAX_SUMMARY_TIMES = 6;
const MAX_SUMMARY_LINES = 8;
const MAX_SUMMARY_EVENTS = 5;
const SUMMARY_DAYS_AHEAD = 7;

const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Kiev';
  } catch (e) {
    return 'Europe/Kiev';
  }
})();

const INTERVALS = [
  { min: 15, label: '15 хв' },
  { min: 30, label: '30 хв' },
  { min: 60, label: '1 год' },
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
];

const SUMMARY_INTERVALS = [
  { min: 120, label: '2 год' },
  { min: 180, label: '3 год' },
  { min: 240, label: '4 год' },
];

const DEADLINE_DAYS = [
  { key: 'none', label: 'Без дедлайну' },
  { key: 'today', label: 'Сьогодні' },
  { key: 'tomorrow', label: 'Завтра' },
  { key: 'pick', label: 'Дата…' },
];

const EVENT_DAYS = DEADLINE_DAYS.filter((d) => d.key !== 'none');

const EVENT_REMINDERS = [
  { key: 15, label: 'за 15 хв' },
  { key: 30, label: 'за 30 хв' },
  { key: 60, label: 'за 1 год' },
  { key: 1440, label: 'за день' },
];

const KINDS = [
  { key: 'task', label: 'Завдання' },
  { key: 'event', label: 'Подія' },
];

const WEEKDAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

function nagTitle(order) {
  if (order <= 1) return 'Тук-тук!';
  if (order <= 3) return 'Знову тук-тук';
  if (order <= 6) return 'Я не відстану';
  return 'Ну досить відкладати!';
}

// ---------- Дата і час ----------

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(d) {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
}

function todayLabel() {
  const d = new Date();
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function minutesLabel(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function isSameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function addDays(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function endOfDay(d) {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

function modeForDate(d) {
  if (!d) return 'none';
  const now = new Date();
  if (isSameDay(d, now)) return 'today';
  if (isSameDay(d, addDays(now, 1))) return 'tomorrow';
  return 'pick';
}

function withDay(target, daySource) {
  const d = new Date(target);
  d.setFullYear(daySource.getFullYear(), daySource.getMonth(), daySource.getDate());
  return d;
}

function nextFullHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function deadlineInfo(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const time = formatTime(d);

  if (d < now) return { text: 'прострочено', overdue: true };
  if (isSameDay(d, now)) return { text: `до ${time}`, overdue: false };
  if (isSameDay(d, addDays(now, 1))) return { text: `завтра до ${time}`, overdue: false };
  return { text: `${formatDate(d)} до ${time}`, overdue: false };
}

function openPicker({ value, mode, minimumDate, onPick }) {
  DateTimePickerAndroid.open({
    value,
    mode,
    is24Hour: true,
    minimumDate,
    onValueChange: (...args) => {
      const date = args.find((a) => a instanceof Date);
      if (date) onPick(date);
    },
    onDismiss: () => {},
  });
}

// ---------- Налаштування ----------

function getSetting(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? Number(row.value) : defaultValue;
}

function getSettingText(key, defaultValue) {
  const row = db.getFirstSync('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.runSync(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    key,
    String(value)
  );
}

function parseTimes(text) {
  return text
    .split(',')
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

function loadSettings() {
  const oldStart = getSetting('start_hour', 8) * 60;
  const oldEnd = getSetting('end_hour', 22) * 60;
  return {
    intervalMin: getSetting('interval_min', 60),
    startMin: getSetting('start_min', oldStart),
    endMin: getSetting('end_min', oldEnd),
    summaryEnabled: getSetting('summary_enabled', 1) === 1,
    summaryMode: getSettingText('summary_mode', 'interval'),
    summaryIntervalMin: getSetting('summary_interval', 180),
    summaryTimes: parseTimes(getSettingText('summary_times', '540,780,1080')),
  };
}

function loadTasks() {
  return db.getAllSync(
    "SELECT id, title, deadline, created_at FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
}

function intervalLabel(min) {
  const found = INTERVALS.find((i) => i.min === min);
  return found ? found.label : `${min} хв`;
}

// ---------- Календар ----------

async function hasCalendarPermission(ask) {
  const { status } = ask
    ? await Calendar.requestCalendarPermissionsAsync()
    : await Calendar.getCalendarPermissionsAsync();
  return status === 'granted';
}

async function getMainCalendar() {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const writable = calendars.filter((c) => c.allowsModifications);
  const owner = Calendar.CalendarAccessLevel.OWNER;
  return (
    writable.find((c) => c.isPrimary) ||
    writable.find((c) => c.source?.type === 'com.google' && c.accessLevel === owner) ||
    writable.find((c) => c.accessLevel === owner) ||
    writable[0] ||
    null
  );
}

async function loadEvents(from, to, ask = false) {
  try {
    if (!(await hasCalendarPermission(ask))) return null;
    const calendar = await getMainCalendar();
    if (!calendar) return [];
    const events = await Calendar.getEventsAsync([calendar.id], from, to);
    return events
      .map((e) => {
        const start = new Date(e.startDate);
        return {
          key: `${e.id}-${start.getTime()}`,
          calendarEventId: String(e.id),
          title: e.title || '(без назви)',
          start,
          allDay: e.allDay,
        };
      })
      .sort((a, b) => a.start - b.start);
  } catch (e) {
    console.warn(e);
    return [];
  }
}

function loadTodayEvents(ask = false) {
  const now = new Date();
  return loadEvents(now, endOfDay(now), ask);
}

function eventTime(e) {
  return e.allDay ? 'весь день' : formatTime(e.start);
}

// ---------- Мої події (створені в застосунку) ----------

function rowToEvent(r) {
  return {
    key: `own-${r.id}`,
    own: true,
    id: r.id,
    calendarEventId: r.calendar_event_id,
    title: r.title,
    start: new Date(r.start_at),
    end: new Date(r.end_at),
    reminderMin: r.reminder_min,
    allDay: false,
  };
}

function loadOwnUpcomingEvents() {
  return db
    .getAllSync(
      "SELECT * FROM events WHERE status = 'active' AND end_at >= ? ORDER BY start_at",
      new Date().toISOString()
    )
    .map(rowToEvent);
}

function loadOwnPastEvents() {
  return db
    .getAllSync(
      "SELECT * FROM events WHERE status = 'active' AND end_at < ? ORDER BY start_at DESC LIMIT 200",
      new Date().toISOString()
    )
    .map(rowToEvent);
}

// Якщо подію змінили або видалили в Google Календарі, оновлюємо її тут
async function syncOwnEvents() {
  try {
    if (!(await hasCalendarPermission(false))) return;
    const rows = db.getAllSync(
      "SELECT id, calendar_event_id FROM events WHERE status = 'active' AND end_at >= ?",
      addDays(new Date(), -1).toISOString()
    );
    for (const r of rows) {
      let ev = null;
      try {
        ev = await Calendar.getEventAsync(r.calendar_event_id);
      } catch (e) {
        ev = null;
      }
      if (!ev) {
        db.runSync("UPDATE events SET status = 'deleted' WHERE id = ?", r.id);
      } else {
        db.runSync(
          'UPDATE events SET title = ?, start_at = ?, end_at = ? WHERE id = ?',
          ev.title || '(без назви)',
          new Date(ev.startDate).toISOString(),
          new Date(ev.endDate).toISOString(),
          r.id
        );
      }
    }
  } catch (e) {
    console.warn(e);
  }
}

// Мої майбутні події + інші події з календаря на сьогодні (без дублів)
function mergeEvents(own, todayCalendar) {
  const ownIds = new Set(own.map((e) => e.calendarEventId));
  const others = (todayCalendar || []).filter((e) => !ownIds.has(e.calendarEventId));
  return [...own, ...others].sort((a, b) => a.start - b.start);
}

function dayLabel(d) {
  const now = new Date();
  if (isSameDay(d, now)) return 'сьогодні';
  if (isSameDay(d, addDays(now, 1))) return 'завтра';
  return formatDate(d);
}

function loadDoneTasks() {
  return db.getAllSync(
    "SELECT id, title, created_at, done_at FROM tasks WHERE status = 'done' ORDER BY done_at DESC LIMIT 200"
  );
}

// ---------- Розклад нагадувань ----------

function slotsFor(createdAtIso, s) {
  const created = new Date(createdAtIso);
  const base = created.getHours() * 60 + created.getMinutes();
  const slots = [];
  for (let m = base % s.intervalMin; m < 24 * 60; m += s.intervalMin) {
    if (m >= s.startMin && m <= s.endMin) {
      const offset = (m - base + 1440) % 1440 || 1440;
      slots.push({ hour: Math.floor(m / 60), minute: m % 60, offset });
    }
  }
  slots.sort((a, b) => a.offset - b.offset);
  return slots.map((slot, i) => ({ ...slot, order: i + 1 }));
}

function countReminders(createdIso, doneIso, s) {
  const created = new Date(createdIso);
  const done = new Date(doneIso);
  const slots = slotsFor(createdIso, s);
  let count = 0;
  const day = startOfDay(created);
  while (day <= done) {
    for (const slot of slots) {
      const t = new Date(day);
      t.setHours(slot.hour, slot.minute, 0, 0);
      if (t > created && t <= done) count += 1;
    }
    day.setDate(day.getDate() + 1);
  }
  return count;
}

function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'менше хвилини';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days} дн`);
  if (hours) parts.push(`${hours} год`);
  if (mins && !days) parts.push(`${mins} хв`);
  return parts.join(' ');
}

function remindersWord(n) {
  return n % 10 === 1 && n % 100 !== 11 ? 'нагадування' : 'нагадувань';
}

function timesWord(n) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return 'раз';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'рази';
  return 'разів';
}

function nagBadge(task, s) {
  const n = countReminders(task.created_at, new Date().toISOString(), s);
  return n === 0 ? 'ще не тукала' : `тукала ${n} ${timesWord(n)}`;
}

function doneSummary(task) {
  const duration = formatDuration(new Date(task.done_at) - new Date(task.created_at));
  const count = countReminders(task.created_at, task.done_at, loadSettings());
  if (count === 0) return `за ${duration}, без жодного нагадування`;
  return `за ${duration}, після ${count} ${remindersWord(count)}`;
}

// ---------- Зведення ----------

function summarySlots(s) {
  if (!s.summaryEnabled) return [];
  if (s.summaryMode === 'times') {
    return [...new Set(s.summaryTimes)].sort((a, b) => a - b);
  }
  const slots = [];
  for (let m = s.startMin; m <= s.endMin; m += s.summaryIntervalMin) slots.push(m);
  return slots;
}

function summaryLabel(s) {
  if (!s.summaryEnabled) return 'зведення вимкнено';
  if (s.summaryMode === 'times') {
    return `зведення о ${summarySlots(s).map(minutesLabel).join(', ')}`;
  }
  return `зведення кожні ${s.summaryIntervalMin / 60} год`;
}

function tasksWord(n) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return 'справа чекає';
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return 'справи чекають';
  return 'справ чекають';
}

function loadSummaryTasks() {
  return db.getAllSync(
    "SELECT title, deadline FROM tasks WHERE status = 'active' ORDER BY deadline IS NULL, deadline, id"
  );
}

function summaryContent(list, dayEvents) {
  const lines = list.slice(0, MAX_SUMMARY_LINES).map((t, i) => {
    if (!t.deadline) return `${i + 1}. ${t.title}`;
    const d = new Date(t.deadline);
    return `${i + 1}. ${t.title} · до ${formatDate(d)} ${formatTime(d)}`;
  });
  if (list.length > MAX_SUMMARY_LINES) {
    lines.push(`і ще ${list.length - MAX_SUMMARY_LINES}`);
  }
  const upcoming = dayEvents.slice(0, MAX_SUMMARY_EVENTS);
  if (upcoming.length) {
    if (lines.length) lines.push('');
    lines.push('Сьогодні в календарі:');
    for (const e of upcoming) lines.push(`• ${eventTime(e)} ${e.title}`);
  }
  return {
    title: list.length ? `${list.length} ${tasksWord(list.length)}` : 'Сьогодні в календарі',
    body: lines.join('\n'),
    data: { type: 'summary' },
  };
}

function eventsForSummaryAt(time, events) {
  return events.filter(
    (e) => isSameDay(e.start, time) && (e.allDay || e.start >= time)
  );
}

// ---------- Сповіщення ----------

async function setupNotifications() {
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Нагадування',
    importance: Notifications.AndroidImportance.HIGH,
    lightColor: C.green,
  });
  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    {
      identifier: 'done',
      buttonTitle: 'Готово',
      options: { opensAppToForeground: true },
    },
    {
      identifier: 'snooze',
      buttonTitle: `Через ${SNOOZE_MIN} хв`,
      options: { opensAppToForeground: true },
    },
  ]);
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Сповіщення вимкнені',
      'Без дозволу на сповіщення нагадування не приходитимуть. Увімкни їх у налаштуваннях телефона.'
    );
  }
}

function notificationBody(task) {
  if (!task.deadline) return task.title;
  const d = new Date(task.deadline);
  return `${task.title} · дедлайн ${formatDate(d)} о ${formatTime(d)}`;
}

async function doReschedule() {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (!n.identifier.startsWith(SNOOZE_PREFIX)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier);
    }
  }

  const s = loadSettings();
  const active = db.getAllSync(
    "SELECT id, title, created_at, deadline FROM tasks WHERE status = 'active'"
  );

  for (const t of active) {
    for (const slot of slotsFor(t.created_at, s)) {
      await Notifications.scheduleNotificationAsync({
        content: {
          title: nagTitle(slot.order),
          body: notificationBody(t),
          data: { taskId: t.id },
          categoryIdentifier: CATEGORY_ID,
          color: C.green,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: slot.hour,
          minute: slot.minute,
          channelId: CHANNEL_ID,
        },
      });
    }
  }

  const slots = summarySlots(s);
  if (slots.length === 0) return;

  const now = new Date();
  const events =
    (await loadEvents(now, endOfDay(addDays(now, SUMMARY_DAYS_AHEAD - 1)), false)) || [];
  const taskList = loadSummaryTasks();

  for (let day = 0; day < SUMMARY_DAYS_AHEAD; day += 1) {
    const date = startOfDay(addDays(now, day));
    for (const m of slots) {
      const time = new Date(date);
      time.setHours(Math.floor(m / 60), m % 60, 0, 0);
      if (time <= now) continue;

      const dayEvents = eventsForSummaryAt(time, events);
      if (taskList.length === 0 && dayEvents.length === 0) continue;

      await Notifications.scheduleNotificationAsync({
        content: { ...summaryContent(taskList, dayEvents), color: C.green },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: time,
          channelId: CHANNEL_ID,
        },
      });
    }
  }
}

let rescheduleChain = Promise.resolve();
function rescheduleAll() {
  rescheduleChain = rescheduleChain.then(doReschedule).catch(console.warn);
  return rescheduleChain;
}

async function dismissTaskNotifications(taskId) {
  const presented = await Notifications.getPresentedNotificationsAsync();
  for (const n of presented) {
    if (n.request.content.data?.taskId === taskId) {
      await Notifications.dismissNotificationAsync(n.request.identifier);
    }
  }
}

async function cancelSnooze(taskId) {
  try {
    await Notifications.cancelScheduledNotificationAsync(`${SNOOZE_PREFIX}${taskId}`);
  } catch (e) {
    // відкладеного нагадування не було, нічого страшного
  }
}

async function snoozeTask(taskId) {
  const t = db.getFirstSync(
    "SELECT id, title, deadline FROM tasks WHERE id = ? AND status = 'active'",
    taskId
  );
  await dismissTaskNotifications(taskId);
  if (!t) return null;
  await cancelSnooze(taskId);
  await Notifications.scheduleNotificationAsync({
    identifier: `${SNOOZE_PREFIX}${taskId}`,
    content: {
      title: 'Відпочила? Тук-тук, я тут',
      body: notificationBody(t),
      data: { taskId: t.id },
      categoryIdentifier: CATEGORY_ID,
      color: C.green,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: SNOOZE_MIN * 60,
      channelId: CHANNEL_ID,
    },
  });
  return t;
}

// Прибирання сповіщень і перепланування йдуть у фоні, щоб екран не чекав
function cleanupTaskInBackground(taskId) {
  (async () => {
    try {
      await dismissTaskNotifications(taskId);
      await cancelSnooze(taskId);
    } catch (e) {
      console.warn(e);
    }
    rescheduleAll();
  })();
}

// Миттєво позначає в базі. Повертає закрите завдання або null
function completeTask(taskId) {
  const result = db.runSync(
    "UPDATE tasks SET status = 'done', done_at = ? WHERE id = ? AND status = 'active'",
    new Date().toISOString(),
    taskId
  );
  cleanupTaskInBackground(taskId);
  if (result.changes === 0) return null;
  return db.getFirstSync(
    'SELECT id, title, created_at, done_at FROM tasks WHERE id = ?',
    taskId
  );
}

function undoTask(taskId) {
  db.runSync(
    "UPDATE tasks SET status = 'active', done_at = NULL WHERE id = ?",
    taskId
  );
  rescheduleAll();
}

function deleteTask(taskId) {
  db.runSync('DELETE FROM tasks WHERE id = ?', taskId);
  cleanupTaskInBackground(taskId);
}

function clearDoneTasks() {
  db.runSync("DELETE FROM tasks WHERE status = 'done'");
}

async function sendTestNotification() {
  const t = db.getFirstSync(
    "SELECT id, title, deadline FROM tasks WHERE status = 'active' ORDER BY id DESC"
  );
  if (!t) {
    Alert.alert('Немає завдань', 'Спочатку додай хоча б одне завдання.');
    return;
  }
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${nagTitle(4)} (тест)`,
      body: notificationBody(t),
      data: { taskId: t.id },
      categoryIdentifier: CATEGORY_ID,
      color: C.green,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
  Alert.alert('Тест', 'Згорни застосунок, сповіщення прийде через 10 секунд.');
}

async function sendTestSummary() {
  const list = loadSummaryTasks();
  const events = (await loadTodayEvents(false)) || [];
  if (list.length === 0 && events.length === 0) {
    Alert.alert('Немає справ', 'Зведення приходить, тільки коли є завдання або події на сьогодні.');
    return;
  }
  const content = summaryContent(list, events);
  await Notifications.scheduleNotificationAsync({
    content: { ...content, title: `${content.title} (тест)`, color: C.green },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 10,
      channelId: CHANNEL_ID,
    },
  });
  Alert.alert('Тест', 'Згорни застосунок, зведення прийде через 10 секунд.');
}

// ---------- Іконки ----------

function BellIcon({ size = 24, color = C.cream }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Path d="M20 28a12 12 0 0 1 24 0c0 13 5 17 5 17H15s5-4 5-17" fill={color} stroke={color} strokeWidth={3} strokeLinejoin="round" />
      <Path d="M27.5 51a5 5 0 0 0 9 0" fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" />
    </Svg>
  );
}

function CheckIcon({ size = 22, color = C.green }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function PlusIcon({ size = 24, color = C.white }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 5v14M5 12h14" fill="none" stroke={color} strokeWidth={2.8} strokeLinecap="round" />
    </Svg>
  );
}

function SlidersIcon({ size = 22, color = C.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Circle cx={16} cy={6} r={2} fill="none" stroke={color} strokeWidth={2} />
      <Circle cx={10} cy={12} r={2} fill="none" stroke={color} strokeWidth={2} />
      <Circle cx={18} cy={18} r={2} fill="none" stroke={color} strokeWidth={2} />
    </Svg>
  );
}

function BackIcon({ size = 22, color = C.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="m15 18-6-6 6-6" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function HistoryIcon({ size = 22, color = C.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M3 12a9 9 0 1 0 3-6.7L3 8" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M3 3v5h5M12 7v5l3 2" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function PencilIcon({ size = 18, color = C.blue }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// ---------- Спільні компоненти ----------

// variant "solid": вибране зелене; "soft": вибране м'ятне
function Chips({ items, value, onChange, variant = 'solid' }) {
  return (
    <View style={styles.chips}>
      {items.map((i) => {
        const active = value === i.key;
        return (
          <Pressable
            key={i.key}
            style={[
              styles.chip,
              active && (variant === 'soft' ? styles.chipSoftActive : styles.chipSolidActive),
            ]}
            onPress={() => onChange(i.key)}
          >
            <Text
              style={[
                styles.chipText,
                active && (variant === 'soft' ? styles.chipSoftText : styles.chipSolidText),
              ]}
            >
              {i.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Segmented({ items, value, onChange }) {
  return (
    <View style={styles.segmented}>
      {items.map((i) => {
        const active = value === i.key;
        return (
          <Pressable
            key={i.key}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => onChange(i.key)}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{i.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TimeTile({ label, value, onPress }) {
  return (
    <Pressable style={styles.timeTile} onPress={onPress}>
      <Text style={styles.timeTileLabel}>{label}</Text>
      <Text style={styles.timeTileValue}>{value}</Text>
    </Pressable>
  );
}

function pickMinutes(value, onChange) {
  const d = new Date();
  d.setHours(Math.floor(value / 60), value % 60, 0, 0);
  openPicker({
    value: d,
    mode: 'time',
    onPick: (date) => onChange(date.getHours() * 60 + date.getMinutes()),
  });
}

// ---------- Налаштування ----------

function SettingsScreen({ onBack }) {
  const initial = loadSettings();
  const [intervalMin, setIntervalMin] = useState(initial.intervalMin);
  const [startMin, setStartMin] = useState(initial.startMin);
  const [endMin, setEndMin] = useState(initial.endMin);
  const [summaryEnabled, setSummaryEnabled] = useState(initial.summaryEnabled);
  const [summaryMode, setSummaryMode] = useState(initial.summaryMode);
  const [summaryIntervalMin, setSummaryIntervalMin] = useState(initial.summaryIntervalMin);
  const [summaryTimes, setSummaryTimes] = useState(initial.summaryTimes);

  const updateTime = (index, value) => {
    setSummaryTimes(summaryTimes.map((t, i) => (i === index ? value : t)));
  };

  const removeTime = (index) => {
    setSummaryTimes(summaryTimes.filter((_, i) => i !== index));
  };

  const addTime = () => {
    const last = summaryTimes.length ? Math.max(...summaryTimes) : 540;
    setSummaryTimes([...summaryTimes, Math.min(last + 180, 23 * 60)]);
  };

  const save = () => {
    if (startMin >= endMin) {
      Alert.alert('Помилка', 'Початок має бути раніше, ніж кінець');
      return;
    }
    if (summaryEnabled && summaryMode === 'times' && summaryTimes.length === 0) {
      Alert.alert('Помилка', 'Додай хоча б один час для зведення');
      return;
    }
    const cleanTimes = [...new Set(summaryTimes)].sort((a, b) => a - b);
    setSetting('interval_min', intervalMin);
    setSetting('start_min', startMin);
    setSetting('end_min', endMin);
    setSetting('summary_enabled', summaryEnabled ? 1 : 0);
    setSetting('summary_mode', summaryMode);
    setSetting('summary_interval', summaryIntervalMin);
    setSetting('summary_times', cleanTimes.join(','));
    onBack(true);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <View style={styles.titleRow}>
        <Pressable style={styles.iconButton} onPress={() => onBack(false)} accessibilityLabel="Назад">
          <BackIcon />
        </Pressable>
        <Text style={styles.screenTitle}>Налаштування</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Тукати кожні</Text>
        <Chips
          items={INTERVALS.map((i) => ({ key: i.min, label: i.label }))}
          value={intervalMin}
          onChange={setIntervalMin}
        />
        <View style={styles.tileRow}>
          <TimeTile label="Не раніше" value={minutesLabel(startMin)} onPress={() => pickMinutes(startMin, setStartMin)} />
          <TimeTile label="Не пізніше" value={minutesLabel(endMin)} onPress={() => pickMinutes(endMin, setEndMin)} />
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={[styles.cardTitle, { flex: 1, marginBottom: 0 }]}>Зведення всіх справ</Text>
          <Switch
            value={summaryEnabled}
            onValueChange={setSummaryEnabled}
            trackColor={{ false: '#D5D2C7', true: '#8FCDAA' }}
            thumbColor={summaryEnabled ? C.green : C.white}
          />
        </View>

        {summaryEnabled && (
          <View style={{ marginTop: 12 }}>
            <Segmented
              items={[
                { key: 'interval', label: 'Кожні N год' },
                { key: 'times', label: 'У певний час' },
              ]}
              value={summaryMode}
              onChange={setSummaryMode}
            />

            {summaryMode === 'interval' && (
              <View style={{ marginTop: 12 }}>
                <Text style={styles.hint}>
                  Від {minutesLabel(startMin)} до {minutesLabel(endMin)}, кожні:
                </Text>
                <Chips
                  items={SUMMARY_INTERVALS.map((i) => ({ key: i.min, label: i.label }))}
                  value={summaryIntervalMin}
                  onChange={setSummaryIntervalMin}
                />
              </View>
            )}

            {summaryMode === 'times' && (
              <View style={{ marginTop: 12 }}>
                {summaryTimes.map((t, i) => (
                  <View key={i} style={styles.summaryTimeRow}>
                    <TimeTile label={`Зведення ${i + 1}`} value={minutesLabel(t)} onPress={() => pickMinutes(t, (v) => updateTime(i, v))} />
                    <Pressable
                      style={styles.removeButton}
                      onPress={() => removeTime(i)}
                      accessibilityLabel="Прибрати час"
                    >
                      <Text style={styles.removeText}>✕</Text>
                    </Pressable>
                  </View>
                ))}
                {summaryTimes.length < MAX_SUMMARY_TIMES && (
                  <Pressable style={styles.dashedButton} onPress={addTime}>
                    <Text style={styles.linkText}>+ Додати час</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        )}
      </View>

      <Pressable style={styles.primaryButton} onPress={save}>
        <Text style={styles.primaryButtonText}>Зберегти</Text>
      </Pressable>
      <Pressable style={styles.ghostButton} onPress={() => onBack(false)}>
        <Text style={styles.ghostButtonText}>Назад без збереження</Text>
      </Pressable>

      <View style={[styles.card, { marginTop: 16 }]}>
        <Text style={styles.cardTitle}>Для тестування</Text>
        <Pressable style={styles.testButton} onPress={sendTestNotification}>
          <Text style={styles.testText}>Нагадування через 10 секунд</Text>
        </Pressable>
        <Pressable style={styles.testButton} onPress={sendTestSummary}>
          <Text style={styles.testText}>Зведення через 10 секунд</Text>
        </Pressable>
      </View>
      <StatusBar style="dark" />
    </ScrollView>
  );
}

// ---------- Історія: виконані справи і минулі події ----------

function doneDateLabel(iso) {
  const d = new Date(iso);
  return `${dayLabel(d)} о ${formatTime(d)}`;
}

function HistoryScreen({ onBack }) {
  const [tab, setTab] = useState('tasks');
  const [doneTasks, setDoneTasks] = useState(loadDoneTasks);
  const [pastEvents] = useState(loadOwnPastEvents);

  const restore = (task) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    undoTask(task.id);
    setDoneTasks(loadDoneTasks());
  };

  const confirmClear = () => {
    Alert.alert('Очистити історію?', 'Усі виконані справи буде видалено назавжди.', [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Очистити',
        style: 'destructive',
        onPress: () => {
          clearDoneTasks();
          setDoneTasks([]);
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Pressable style={styles.iconButton} onPress={onBack} accessibilityLabel="Назад">
          <BackIcon />
        </Pressable>
        <Text style={styles.screenTitle}>Виконано</Text>
      </View>

      <Segmented
        items={[
          { key: 'tasks', label: `Справи · ${doneTasks.length}` },
          { key: 'events', label: `Події · ${pastEvents.length}` },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'tasks' && (
        <FlatList
          style={{ marginTop: 12 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          data={doneTasks}
          keyExtractor={(item) => String(item.id)}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>Поки порожньо</Text>
              <Text style={styles.hint}>Тут з'являться справи, які ти закрила.</Text>
            </View>
          }
          ListFooterComponent={
            doneTasks.length > 0 ? (
              <Pressable style={styles.ghostButton} onPress={confirmClear}>
                <Text style={[styles.ghostButtonText, { color: C.red }]}>Очистити історію</Text>
              </Pressable>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={styles.historyCard}>
              <View style={styles.historyCheck}>
                <CheckIcon size={16} color={C.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyTitle}>{item.title}</Text>
                <Text style={styles.historyMeta}>
                  {doneDateLabel(item.done_at)} · {doneSummary(item)}
                </Text>
              </View>
              <Pressable style={styles.restoreButton} onPress={() => restore(item)}>
                <Text style={styles.restoreText}>Повернути</Text>
              </Pressable>
            </View>
          )}
        />
      )}

      {tab === 'events' && (
        <FlatList
          style={{ marginTop: 12 }}
          contentContainerStyle={{ paddingBottom: 40 }}
          data={pastEvents}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Text style={styles.emptyTitle}>Поки порожньо</Text>
              <Text style={styles.hint}>Тут з'являться події, які вже минули.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.historyCard}>
              <View style={[styles.historyCheck, { backgroundColor: C.blue }]}>
                <CheckIcon size={16} color={C.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.historyTitle}>{item.title}</Text>
                <Text style={styles.historyMeta}>
                  {formatDate(item.start)} · {formatTime(item.start)}–{formatTime(item.end)}
                </Text>
              </View>
            </View>
          )}
        />
      )}
      <StatusBar style="dark" />
    </View>
  );
}

// ---------- Головний екран ----------

export default function App() {
  const [fontsLoaded] = useFonts({
    Nunito_500Medium, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black,
  });

  const [screen, setScreen] = useState('tasks');
  const [kind, setKind] = useState('task');
  const [text, setText] = useState('');

  const [deadlineMode, setDeadlineMode] = useState('none');
  const [deadline, setDeadline] = useState(null);
  // editing: { type: 'task', id, originalDeadline } або { type: 'event', id, calendarEventId, originalStart }
  const [editing, setEditing] = useState(null);

  const [eventStart, setEventStart] = useState(nextFullHour);
  const [eventEnd, setEventEnd] = useState(() => new Date(nextFullHour().getTime() + 3600000));
  const [eventReminder, setEventReminder] = useState(30);
  const [ownEvents, setOwnEvents] = useState(loadOwnUpcomingEvents);
  const [calendarToday, setCalendarToday] = useState(undefined);

  const [completingId, setCompletingId] = useState(null);
  const [lastDone, setLastDone] = useState(null);
  const [infoMsg, setInfoMsg] = useState(null);
  const [tasks, setTasks] = useState(loadTasks);
  const [settings, setSettings] = useState(loadSettings);

  const showDone = (task) => {
    if (!task) return;
    setLastDone({ id: task.id, title: task.title, summary: doneSummary(task) });
  };

  const refreshEvents = async (ask) => {
    await syncOwnEvents();
    setOwnEvents(loadOwnUpcomingEvents());
    setCalendarToday(await loadTodayEvents(ask));
  };

  useEffect(() => {
    const handleResponse = (response) => {
      const taskId = response?.notification.request.content.data?.taskId;
      if (!taskId) return;
      if (response.actionIdentifier === 'done') {
        showDone(completeTask(taskId));
        setTasks(loadTasks());
      } else if (response.actionIdentifier === 'snooze') {
        snoozeTask(taskId).then((t) => {
          if (t) setInfoMsg(`«${t.title}»: тукну через ${SNOOZE_MIN} хв`);
        });
      }
    };

    setupNotifications().then(rescheduleAll);
    refreshEvents(false);
    Notifications.getLastNotificationResponseAsync().then(handleResponse);
    const sub = Notifications.addNotificationResponseReceivedListener(handleResponse);

    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        refreshEvents(false);
        setTasks(loadTasks());
        rescheduleAll();
      }
    });

    return () => {
      sub.remove();
      appSub.remove();
    };
  }, []);

  useEffect(() => {
    if (!lastDone) return undefined;
    const timer = setTimeout(() => setLastDone(null), UNDO_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [lastDone]);

  useEffect(() => {
    if (!infoMsg) return undefined;
    const timer = setTimeout(() => setInfoMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [infoMsg]);

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: C.cream }} />;
  }

  if (screen === 'settings') {
    return (
      <SettingsScreen
        onBack={(changed) => {
          setSettings(loadSettings());
          if (changed) rescheduleAll();
          setScreen('tasks');
        }}
      />
    );
  }

  if (screen === 'history') {
    return (
      <HistoryScreen
        onBack={() => {
          setTasks(loadTasks());
          setScreen('tasks');
        }}
      />
    );
  }

  // ----- Завдання -----

  const keptHours = deadline ? deadline.getHours() : 18;
  const keptMinutes = deadline ? deadline.getMinutes() : 0;

  const chooseDay = (key) => {
    if (key === 'none') {
      setDeadlineMode('none');
      setDeadline(null);
      return;
    }

    if (key === 'pick') {
      openPicker({
        value: deadline ?? new Date(),
        mode: 'date',
        minimumDate: new Date(),
        onPick: (date) => {
          const d = new Date(date);
          d.setHours(keptHours, keptMinutes, 0, 0);
          setDeadline(d);
          setDeadlineMode('pick');
        },
      });
      return;
    }

    const d = key === 'tomorrow' ? addDays(new Date(), 1) : new Date();
    d.setHours(keptHours, keptMinutes, 0, 0);
    setDeadline(d);
    setDeadlineMode(key);
  };

  const pickTime = () => {
    openPicker({
      value: deadline,
      mode: 'time',
      onPick: (date) => {
        const d = new Date(deadline);
        d.setHours(date.getHours(), date.getMinutes(), 0, 0);
        setDeadline(d);
      },
    });
  };

  const resetForm = () => {
    setText('');
    setDeadlineMode('none');
    setDeadline(null);
    setEditing(null);
    const start = nextFullHour();
    setEventStart(start);
    setEventEnd(new Date(start.getTime() + 3600000));
    setEventReminder(30);
    Keyboard.dismiss();
  };

  const startEdit = (item) => {
    const d = item.deadline ? new Date(item.deadline) : null;
    setKind('task');
    setEditing({ type: 'task', id: item.id, originalDeadline: item.deadline });
    setText(item.title);
    setDeadline(d);
    setDeadlineMode(modeForDate(d));
  };

  const saveTask = () => {
    const title = text.trim();
    if (!title) return;

    const deadlineIso = deadline ? deadline.toISOString() : null;
    const deadlineChanged = !editing || deadlineIso !== editing.originalDeadline;
    if (deadline && deadline < new Date() && deadlineChanged) {
      Alert.alert('Цей час уже минув', 'Обери пізніший час або інший день.');
      return;
    }

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (editing) {
      db.runSync(
        'UPDATE tasks SET title = ?, deadline = ? WHERE id = ?',
        title,
        deadlineIso,
        editing.id
      );
    } else {
      db.runSync(
        'INSERT INTO tasks (title, created_at, deadline) VALUES (?, ?, ?)',
        title,
        new Date().toISOString(),
        deadlineIso
      );
    }
    setTasks(loadTasks());
    resetForm();
    rescheduleAll();
  };

  const confirmDeleteTask = () => {
    const id = editing.id;
    Alert.alert('Видалити завдання?', text.trim(), [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Видалити',
        style: 'destructive',
        onPress: () => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          deleteTask(id);
          setTasks(loadTasks());
          resetForm();
        },
      },
    ]);
  };

  // Кружечок одразу стає зеленим, а завдання плавно зникає
  const doneTask = (id) => {
    if (completingId) return;
    if (editing?.id === id && editing.type === 'task') resetForm();
    setCompletingId(id);
    setTimeout(() => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      const task = completeTask(id);
      setTasks(loadTasks());
      setCompletingId(null);
      showDone(task);
    }, 250);
  };

  const undoLast = () => {
    const id = lastDone.id;
    setLastDone(null);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    undoTask(id);
    setTasks(loadTasks());
  };

  // ----- Подія -----

  const chooseEventDay = (key) => {
    if (key === 'pick') {
      openPicker({
        value: eventStart,
        mode: 'date',
        minimumDate: new Date(),
        onPick: (date) => {
          setEventStart(withDay(eventStart, date));
          setEventEnd(withDay(eventEnd, date));
        },
      });
      return;
    }
    const day = key === 'tomorrow' ? addDays(new Date(), 1) : new Date();
    setEventStart(withDay(eventStart, day));
    setEventEnd(withDay(eventEnd, day));
  };

  const pickEventTime = (which) => {
    const current = which === 'start' ? eventStart : eventEnd;
    openPicker({
      value: current,
      mode: 'time',
      onPick: (date) => {
        const d = new Date(current);
        d.setHours(date.getHours(), date.getMinutes(), 0, 0);
        if (which === 'start') {
          setEventStart(d);
          if (eventEnd <= d) setEventEnd(new Date(d.getTime() + 3600000));
        } else {
          setEventEnd(d);
        }
      },
    });
  };

  const startEditEvent = (ev) => {
    if (!ev.own) return;
    setKind('event');
    setEditing({
      type: 'event',
      id: ev.id,
      calendarEventId: ev.calendarEventId,
      originalStart: ev.start.getTime(),
    });
    setText(ev.title);
    setEventStart(new Date(ev.start));
    setEventEnd(new Date(ev.end));
    setEventReminder(ev.reminderMin);
  };

  const saveEvent = async () => {
    const title = text.trim();
    if (!title) return;

    const isEditingEvent = editing?.type === 'event';
    const startChanged = !isEditingEvent || eventStart.getTime() !== editing.originalStart;
    if (eventStart < new Date() && startChanged) {
      Alert.alert('Цей час уже минув', 'Обери пізніший час або інший день.');
      return;
    }
    if (eventEnd <= eventStart) {
      Alert.alert('Помилка', 'Кінець події має бути пізніше за початок.');
      return;
    }

    try {
      if (!(await hasCalendarPermission(true))) {
        Alert.alert(
          'Немає доступу до календаря',
          'Щоб додавати події, дозволь доступ до календаря в налаштуваннях телефона.'
        );
        return;
      }

      const details = {
        title,
        startDate: eventStart,
        endDate: eventEnd,
        timeZone: TIME_ZONE,
        alarms: [{ relativeOffset: -eventReminder, method: Calendar.AlarmMethod.ALERT }],
      };

      if (isEditingEvent) {
        await Calendar.updateEventAsync(editing.calendarEventId, details);
        db.runSync(
          'UPDATE events SET title = ?, start_at = ?, end_at = ?, reminder_min = ? WHERE id = ?',
          title,
          eventStart.toISOString(),
          eventEnd.toISOString(),
          eventReminder,
          editing.id
        );
        setInfoMsg('Подію оновлено і в Google Календарі');
      } else {
        const calendar = await getMainCalendar();
        if (!calendar) {
          Alert.alert(
            'Календар не знайдено',
            'Додай Google акаунт у налаштуваннях телефона, щоб записувати події.'
          );
          return;
        }
        const calendarEventId = await Calendar.createEventAsync(calendar.id, details);
        db.runSync(
          'INSERT INTO events (calendar_event_id, title, start_at, end_at, reminder_min, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          String(calendarEventId),
          title,
          eventStart.toISOString(),
          eventEnd.toISOString(),
          eventReminder,
          new Date().toISOString()
        );
        setInfoMsg(`Подію додано в календар «${calendar.title}»`);
      }

      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setOwnEvents(loadOwnUpcomingEvents());
      resetForm();
      refreshEvents(false);
      rescheduleAll();
    } catch (e) {
      console.warn(e);
      Alert.alert('Не вдалося зберегти подію', String(e?.message ?? e));
    }
  };

  const confirmDeleteEvent = () => {
    const { id, calendarEventId } = editing;
    Alert.alert('Видалити подію?', 'Її буде видалено і з Google Календаря.', [
      { text: 'Скасувати', style: 'cancel' },
      {
        text: 'Видалити',
        style: 'destructive',
        onPress: async () => {
          try {
            await Calendar.deleteEventAsync(calendarEventId);
          } catch (e) {
            // у календарі її вже немає, нічого страшного
          }
          db.runSync("UPDATE events SET status = 'deleted' WHERE id = ?", id);
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOwnEvents(loadOwnUpcomingEvents());
          resetForm();
          rescheduleAll();
        },
      },
    ]);
  };

  // ----- Екран -----

  const isEvent = kind === 'event';
  const eventMode = modeForDate(eventStart);
  const editingType = editing?.type;
  const allEvents = mergeEvents(ownEvents, calendarToday);

  const header = (
    <View>
      {allEvents.length > 0 && (
        <View style={{ marginBottom: 4 }}>
          <Text style={styles.sectionTitle}>Події</Text>
          {allEvents.map((e) => {
            const isEditingThis = editingType === 'event' && editing.id === e.id && e.own;
            return (
              <Pressable
                key={e.key}
                style={[styles.eventRow, isEditingThis && styles.taskEditing]}
                onPress={() => startEditEvent(e)}
                disabled={!e.own}
              >
                <View style={styles.eventBadge}>
                  <Text style={styles.eventBadgeDay}>{dayLabel(e.start)}</Text>
                  <Text style={styles.eventBadgeTime}>{eventTime(e)}</Text>
                </View>
                <Text style={styles.eventTitle} numberOfLines={2}>{e.title}</Text>
                {e.own ? <PencilIcon /> : <Text style={styles.eventSource}>календар</Text>}
              </Pressable>
            );
          })}
        </View>
      )}
      {calendarToday === null && (
        <Pressable style={styles.dashedButton} onPress={() => refreshEvents(true)}>
          <Text style={styles.linkText}>Показати події з календаря</Text>
        </Pressable>
      )}
      <Text style={styles.sectionTitle}>
        Тукаю, поки не зробиш{tasks.length ? ` · ${tasks.length}` : ''}
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.brand}>
          <View style={styles.logo}>
            <BellIcon size={24} />
          </View>
          <View>
            <Text style={styles.appName}>{APP_NAME}</Text>
            <Text style={styles.today}>{todayLabel()}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable style={styles.iconButton} onPress={() => setScreen('history')} accessibilityLabel="Виконано">
            <HistoryIcon />
          </Pressable>
          <Pressable style={styles.iconButton} onPress={() => setScreen('settings')} accessibilityLabel="Налаштування">
            <SlidersIcon />
          </Pressable>
        </View>
      </View>

      <Pressable onPress={() => setScreen('settings')}>
        <Text style={styles.settingsLine}>
          Тукаю кожні {intervalLabel(settings.intervalMin)}, {minutesLabel(settings.startMin)}–{minutesLabel(settings.endMin)} · {summaryLabel(settings)}
        </Text>
      </Pressable>

      <View style={styles.formCard}>
        {editing ? (
          <Text style={styles.editTitle}>
            {editingType === 'event' ? 'Редагування події' : 'Редагування завдання'}
          </Text>
        ) : (
          <Segmented items={KINDS} value={kind} onChange={setKind} />
        )}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder={isEvent ? 'Назва події' : 'Що треба зробити?'}
            placeholderTextColor={C.muted}
            value={text}
            onChangeText={setText}
            onSubmitEditing={isEvent ? saveEvent : saveTask}
          />
          <Pressable
            style={[styles.addButton, isEvent && { backgroundColor: C.blue }]}
            onPress={isEvent ? saveEvent : saveTask}
            accessibilityLabel={editing ? 'Зберегти' : 'Додати'}
          >
            {editing ? <CheckIcon color={C.white} /> : <PlusIcon />}
          </Pressable>
        </View>

        {!isEvent && (
          <View>
            <Chips
              variant="soft"
              items={DEADLINE_DAYS.map((d) => ({
                key: d.key,
                label:
                  d.key === deadlineMode && deadline
                    ? `${d.key === 'pick' ? formatDate(deadline) : d.label} · ${formatTime(deadline)}`
                    : d.label,
              }))}
              value={deadlineMode}
              onChange={(key) => (key === deadlineMode && deadline && key !== 'pick' ? pickTime() : chooseDay(key))}
            />
            {deadline && (
              <Pressable onPress={pickTime}>
                <Text style={styles.linkSmall}>Змінити час дедлайну</Text>
              </Pressable>
            )}
          </View>
        )}

        {isEvent && (
          <View>
            <Chips
              variant="soft"
              items={EVENT_DAYS.map((d) => ({
                key: d.key,
                label: d.key === 'pick' && eventMode === 'pick' ? formatDate(eventStart) : d.label,
              }))}
              value={eventMode}
              onChange={chooseEventDay}
            />
            <View style={styles.tileRow}>
              <TimeTile label="Початок" value={formatTime(eventStart)} onPress={() => pickEventTime('start')} />
              <TimeTile label="Кінець" value={formatTime(eventEnd)} onPress={() => pickEventTime('end')} />
            </View>
            <Text style={styles.hint}>Нагадати:</Text>
            <Chips variant="soft" items={EVENT_REMINDERS} value={eventReminder} onChange={setEventReminder} />
          </View>
        )}

        {editing && (
          <View style={styles.editActions}>
            <Pressable
              style={styles.deleteButton}
              onPress={editingType === 'event' ? confirmDeleteEvent : confirmDeleteTask}
            >
              <Text style={styles.deleteText}>Видалити</Text>
            </Pressable>
            <Pressable style={styles.cancelButton} onPress={resetForm}>
              <Text style={styles.cancelText}>Скасувати</Text>
            </Pressable>
          </View>
        )}
      </View>

      <FlatList
        style={{ marginTop: 6 }}
        contentContainerStyle={{ paddingBottom: 110 }}
        data={tasks}
        keyExtractor={(item) => String(item.id)}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Тиша і спокій</Text>
            <Text style={styles.hint}>Додай справу, і я не дам про неї забути.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const info = deadlineInfo(item.deadline);
          const isEditingThis = editingType === 'task' && editing.id === item.id;
          const completing = completingId === item.id;
          return (
            <View style={[styles.taskCard, isEditingThis && styles.taskEditing, completing && { opacity: 0.6 }]}>
              <Pressable style={{ flex: 1 }} onPress={() => startEdit(item)}>
                <Text style={[styles.taskTitle, completing && styles.taskTitleDone]}>{item.title}</Text>
                <View style={styles.badges}>
                  {info && (
                    <Text style={[styles.badge, info.overdue ? styles.badgeOverdue : styles.badgeDeadline]}>
                      {info.text}
                    </Text>
                  )}
                  <Text style={[styles.badge, styles.badgeCount]}>{nagBadge(item, settings)}</Text>
                </View>
              </Pressable>
              <Pressable
                style={[styles.doneButton, completing && styles.doneButtonActive]}
                onPress={() => doneTask(item.id)}
                accessibilityLabel={`Готово: ${item.title}`}
              >
                <CheckIcon color={completing ? C.white : C.green} />
              </Pressable>
            </View>
          );
        }}
      />

      {infoMsg && !lastDone && (
        <View style={styles.snackbar}>
          <Text style={[styles.snackTitle, { flex: 1, paddingVertical: 8 }]}>{infoMsg}</Text>
        </View>
      )}

      {lastDone && (
        <View style={styles.snackbar}>
          <View style={styles.snackCheck}>
            <CheckIcon size={18} color={C.ink} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.snackTitle}>{lastDone.title}: зроблено!</Text>
            <Text style={styles.snackSummary}>{lastDone.summary}</Text>
          </View>
          <Pressable style={styles.undoButton} onPress={undoLast}>
            <Text style={styles.undoText}>Повернути</Text>
          </Pressable>
        </View>
      )}
      <StatusBar style="dark" />
    </View>
  );
}


const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.cream, paddingTop: 52, paddingHorizontal: 16 },
  screen: { flex: 1, backgroundColor: C.cream },
  scrollContent: { paddingTop: 52, paddingHorizontal: 16, paddingBottom: 40 },

  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { width: 42, height: 42, borderRadius: 13, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  appName: { fontFamily: F.black, fontSize: 24, color: C.ink, lineHeight: 28 },
  today: { fontFamily: F.regular, fontSize: 13, color: C.muted },
  iconButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },
  settingsLine: { fontFamily: F.bold, fontSize: 13, color: C.green, marginTop: 10, marginBottom: 10 },

  formCard: { backgroundColor: C.white, borderRadius: 24, padding: 14, gap: 12 },
  editTitle: { fontFamily: F.extra, fontSize: 15, color: C.honeyText },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, height: 50, borderWidth: 2, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, fontSize: 16, fontFamily: F.bold, color: C.ink, backgroundColor: C.creamField },
  addButton: { width: 50, height: 50, borderRadius: 14, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  linkSmall: { fontFamily: F.bold, fontSize: 13, color: C.green, marginTop: -2 },

  segmented: { flexDirection: 'row', gap: 6, padding: 4, backgroundColor: C.mintLight, borderRadius: 14 },
  segment: { flex: 1, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  segmentActive: { backgroundColor: C.green },
  segmentText: { fontFamily: F.bold, fontSize: 15, color: C.text },
  segmentTextActive: { fontFamily: F.extra, color: C.white },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { minHeight: 38, paddingHorizontal: 13, borderRadius: 19, borderWidth: 1.5, borderColor: C.line, backgroundColor: C.white, justifyContent: 'center' },
  chipText: { fontFamily: F.bold, fontSize: 14, color: C.text },
  chipSoftActive: { backgroundColor: C.mint, borderColor: C.mint },
  chipSoftText: { fontFamily: F.extra, color: C.greenDark },
  chipSolidActive: { backgroundColor: C.green, borderColor: C.green },
  chipSolidText: { fontFamily: F.extra, color: C.white },

  tileRow: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 6 },
  timeTile: { flex: 1, minHeight: 62, borderRadius: 16, backgroundColor: C.mintLight, paddingHorizontal: 14, justifyContent: 'center' },
  timeTileLabel: { fontFamily: F.bold, fontSize: 12, color: C.muted },
  timeTileValue: { fontFamily: F.black, fontSize: 20, color: C.greenDark },

  sectionTitle: { fontFamily: F.extra, fontSize: 15, color: C.text, marginTop: 12, marginBottom: 8 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.blueLight, borderRadius: 18, paddingVertical: 10, paddingLeft: 10, paddingRight: 14, marginBottom: 8 },
  eventBadge: { minWidth: 64, borderRadius: 12, backgroundColor: C.white, paddingVertical: 6, paddingHorizontal: 8, alignItems: 'center' },
  eventBadgeDay: { fontFamily: F.bold, fontSize: 11, color: C.muted },
  eventBadgeTime: { fontFamily: F.black, fontSize: 15, color: C.blue },
  eventTitle: { flex: 1, fontFamily: F.extra, fontSize: 16, color: C.ink },
  eventSource: { fontFamily: F.bold, fontSize: 11, color: C.muted },

  historyCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.white, borderRadius: 18, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8 },
  historyCheck: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  historyTitle: { fontFamily: F.extra, fontSize: 16, color: C.ink },
  historyMeta: { fontFamily: F.regular, fontSize: 13, color: C.muted, marginTop: 2 },
  restoreButton: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' },
  restoreText: { fontFamily: F.extra, fontSize: 14, color: C.green },
  taskTitleDone: { textDecorationLine: 'line-through', color: C.muted },
  doneButtonActive: { backgroundColor: C.green },

  taskCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.white, borderRadius: 20, paddingVertical: 14, paddingLeft: 16, paddingRight: 14, marginBottom: 10 },
  taskEditing: { borderWidth: 2, borderColor: C.honey },
  taskTitle: { fontFamily: F.extra, fontSize: 17, color: C.ink },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  badge: { fontSize: 13, borderRadius: 8, paddingVertical: 2, paddingHorizontal: 8, overflow: 'hidden' },
  badgeDeadline: { fontFamily: F.extra, color: C.honeyText, backgroundColor: C.honeyLight },
  badgeOverdue: { fontFamily: F.extra, color: C.white, backgroundColor: C.red },
  badgeCount: { fontFamily: F.bold, color: C.greenDark, backgroundColor: C.mintLight },
  doneButton: { width: 48, height: 48, borderRadius: 24, borderWidth: 3, borderColor: C.green, backgroundColor: C.white, alignItems: 'center', justifyContent: 'center' },

  emptyBox: { backgroundColor: C.white, borderRadius: 20, padding: 20, alignItems: 'center' },
  emptyTitle: { fontFamily: F.black, fontSize: 18, color: C.ink, marginBottom: 4 },

  editActions: { flexDirection: 'row', gap: 8 },
  deleteButton: { flex: 1, minHeight: 46, borderRadius: 14, borderWidth: 2, borderColor: C.red, alignItems: 'center', justifyContent: 'center' },
  deleteText: { fontFamily: F.extra, color: C.red, fontSize: 15 },
  cancelButton: { flex: 1, minHeight: 46, borderRadius: 14, backgroundColor: C.mintLight, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontFamily: F.extra, color: C.text, fontSize: 15 },

  snackbar: { position: 'absolute', left: 14, right: 14, bottom: 24, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.greenDark, borderRadius: 18, paddingVertical: 10, paddingLeft: 14, paddingRight: 6 },
  snackCheck: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.honey, alignItems: 'center', justifyContent: 'center' },
  snackTitle: { fontFamily: F.extra, fontSize: 15, color: C.white },
  snackSummary: { fontFamily: F.regular, fontSize: 13, color: '#CDE8D8', marginTop: 1 },
  undoButton: { paddingVertical: 10, paddingHorizontal: 10 },
  undoText: { fontFamily: F.black, fontSize: 14, color: C.honey },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  screenTitle: { fontFamily: F.black, fontSize: 24, color: C.ink },
  card: { backgroundColor: C.white, borderRadius: 22, padding: 16, marginBottom: 12 },
  cardTitle: { fontFamily: F.extra, fontSize: 15, color: C.text, marginBottom: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center' },
  hint: { fontFamily: F.regular, fontSize: 14, color: C.muted, marginBottom: 8 },
  summaryTimeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  removeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { fontSize: 18, color: C.red },
  dashedButton: { minHeight: 46, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.green, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  linkText: { fontFamily: F.extra, color: C.green, fontSize: 15 },
  primaryButton: { minHeight: 54, borderRadius: 18, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryButtonText: { fontFamily: F.black, fontSize: 17, color: C.white },
  ghostButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  ghostButtonText: { fontFamily: F.bold, fontSize: 15, color: C.muted },
  testButton: { minHeight: 46, borderRadius: 14, borderWidth: 1.5, borderColor: C.honey, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  testText: { fontFamily: F.bold, color: C.honeyText, fontSize: 15 },
});
