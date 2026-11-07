// The test server's clock is fixed at Monday 7 Jan 2030, 10:00 Bangalore time.
// Every date below is worked out from that moment, so tests never go stale.
module.exports = {
  FIXED_NOW: '2030-01-07T10:00',
  TODAY: '2030-01-07', // Monday
  TOMORROW: '2030-01-08', // Tuesday
  LAST_FRIDAY: '2030-01-04',
  SATURDAY: '2030-01-12',
  LAST_BOOKABLE_DAY: '2030-02-06', // today + 30 days (Wednesday)
  FIRST_DAY_TOO_FAR: '2030-02-07', // today + 31 days (Thursday)
  MONDAY: 1,
};
